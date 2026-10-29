package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

// —— 代码仓库实时预览：启动 dev server，并经注入代理把 bridge 脚本塞进页面 ——

// RepoInfo describes a frontend repository chosen by the user.
type RepoInfo struct {
	Dir            string   `json:"dir"`
	Name           string   `json:"name"`
	Scripts        []string `json:"scripts"`
	PackageManager string   `json:"packageManager"`
}

// DevStartOptions configures one dev-server session.
type DevStartOptions struct {
	Dir            string `json:"dir"`
	Script         string `json:"script"`
	PackageManager string `json:"packageManager"`
	// BridgeScript is injected into every HTML page served through the proxy.
	BridgeScript string `json:"bridgeScript"`
}

// DevEvent is one streamed dev-server event: "log" is an output line,
// "ready" carries the proxied page URL once the server is reachable.
type DevEvent struct {
	Type   string `json:"type"`
	Text   string `json:"text,omitempty"`
	URL    string `json:"url,omitempty"`
	Target string `json:"target,omitempty"`
}

// DevServerService runs repository dev servers and injecting proxies.
type DevServerService struct{}

var (
	ansiRe     = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)
	localURLRe = regexp.MustCompile(`https?://(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:/[^\s]*)?`)
	// <head> 或 <head ...>，不能误中 <header>
	headOpenRe = regexp.MustCompile(`(?i)<head(?:\s[^>]*)?>`)
)

// PickRepo opens a native folder picker and inspects the chosen repository.
// Returns an empty Dir when the user canceled.
func (DevServerService) PickRepo(ctx context.Context) (RepoInfo, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Title: "选择前端项目目录", Directory: true})
	if err != nil {
		if err == mygo.ErrCanceled {
			return RepoInfo{}, nil
		}
		return RepoInfo{}, err
	}
	if len(paths) == 0 {
		return RepoInfo{}, nil
	}
	return inspectRepo(paths[0])
}

// inspectRepo reads package.json scripts and infers the package manager from lockfiles.
func inspectRepo(dir string) (RepoInfo, error) {
	b, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return RepoInfo{}, fmt.Errorf("所选目录没有 package.json：%s", dir)
	}
	var pkg struct {
		Name    string            `json:"name"`
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(b, &pkg); err != nil {
		return RepoInfo{}, fmt.Errorf("package.json 解析失败：%w", err)
	}
	scripts := make([]string, 0, len(pkg.Scripts))
	for k := range pkg.Scripts {
		scripts = append(scripts, k)
	}
	sort.Strings(scripts)
	pm := "npm"
	for _, c := range []struct{ file, pm string }{
		{"pnpm-lock.yaml", "pnpm"}, {"yarn.lock", "yarn"}, {"bun.lock", "bun"}, {"bun.lockb", "bun"},
	} {
		if _, err := os.Stat(filepath.Join(dir, c.file)); err == nil {
			pm = c.pm
			break
		}
	}
	name := pkg.Name
	if name == "" {
		name = filepath.Base(dir)
	}
	return RepoInfo{Dir: dir, Name: name, Scripts: scripts, PackageManager: pm}, nil
}

// Start runs `<pm> run <script>` in the repository, streams its output and,
// once a local URL appears, serves it through an injecting proxy. Closing the
// channel on the frontend stops both the proxy and the dev server.
func (DevServerService) Start(ctx context.Context, opts DevStartOptions, out *mygo.Channel[DevEvent]) error {
	pm, err := exec.LookPath(opts.PackageManager)
	if err != nil {
		return fmt.Errorf("未找到 %s，请先安装", opts.PackageManager)
	}
	// 任何提前返回都要连带杀掉进程树
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	cmd := exec.CommandContext(ctx, pm, "run", opts.Script)
	cmd.Dir = opts.Dir
	cmd.Env = append(os.Environ(), "BROWSER=none", "FORCE_COLOR=0", "NO_COLOR=1")
	cmd.WaitDelay = 3 * time.Second
	prepareCmd(cmd)
	pr, pw := io.Pipe()
	defer pr.Close()
	cmd.Stdout = pw
	cmd.Stderr = pw
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动 dev server 失败：%w", err)
	}
	waitDone := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		pw.Close()
		waitDone <- err
	}()

	var stopProxy func()
	defer func() {
		if stopProxy != nil {
			stopProxy()
		}
	}()
	scanner := bufio.NewScanner(pr)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := ansiRe.ReplaceAllString(scanner.Text(), "")
		if err := out.Send(DevEvent{Type: "log", Text: line}); err != nil {
			return err
		}
		if stopProxy != nil {
			continue
		}
		if found := localURLRe.FindString(line); found != "" {
			target, _ := url.Parse(found)
			proxyOrigin, stop, err := startInjectingProxy(target.Scheme+"://"+target.Host, opts.BridgeScript)
			if err != nil {
				return err
			}
			stopProxy = stop
			if err := out.Send(DevEvent{Type: "ready", URL: proxyOrigin + target.RequestURI(), Target: found}); err != nil {
				return err
			}
		}
	}
	err = <-waitDone
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		return fmt.Errorf("dev server 已退出：%w", err)
	}
	return errors.New("dev server 已退出")
}

// Proxy serves an arbitrary website through the injecting proxy (used for
// web capture). It blocks until the frontend closes the channel.
func (DevServerService) Proxy(ctx context.Context, target string, bridgeScript string, out *mygo.Channel[DevEvent]) error {
	u, err := url.Parse(strings.TrimSpace(target))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("无效的网址：%s", target)
	}
	// 先跟随重定向拿到最终地址（如 example.com → www.example.com），
	// 否则跨域跳转会让 iframe 绕过代理、丢失注入脚本
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("无法访问 %s：%w", u.String(), err)
	}
	resp.Body.Close()
	u = resp.Request.URL
	proxyOrigin, stop, err := startInjectingProxy(u.Scheme+"://"+u.Host, bridgeScript)
	if err != nil {
		return err
	}
	defer stop()
	if err := out.Send(DevEvent{Type: "ready", URL: proxyOrigin + u.RequestURI(), Target: u.String()}); err != nil {
		return err
	}
	<-ctx.Done()
	return nil
}

// startInjectingProxy listens on a random loopback port and reverse-proxies
// to target, injecting the bridge script into HTML responses and stripping
// headers that would block framing. WebSocket upgrades (HMR) pass through.
// Returns the proxy origin and a stop function.
func startInjectingProxy(target, bridgeScript string) (string, func(), error) {
	tu, err := url.Parse(target)
	if err != nil {
		return "", nil, err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	proxyOrigin := "http://" + ln.Addr().String()
	targetOrigin := tu.Scheme + "://" + tu.Host
	injection := []byte("<script>" + bridgeScript + "</script>")

	rp := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(tu)
			// 要求明文响应，便于注入 HTML
			r.Out.Header.Del("Accept-Encoding")
			r.Out.Header.Del("Referer")
			if r.Out.Header.Get("Origin") != "" {
				r.Out.Header.Set("Origin", targetOrigin)
			}
		},
		ModifyResponse: func(resp *http.Response) error {
			h := resp.Header
			h.Del("Content-Security-Policy")
			h.Del("Content-Security-Policy-Report-Only")
			h.Del("X-Frame-Options")
			if loc := h.Get("Location"); strings.HasPrefix(loc, targetOrigin) {
				h.Set("Location", proxyOrigin+strings.TrimPrefix(loc, targetOrigin))
			}
			if !strings.Contains(h.Get("Content-Type"), "text/html") || h.Get("Content-Encoding") != "" {
				return nil
			}
			body, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil {
				return err
			}
			at := 0
			if loc := headOpenRe.FindIndex(body); loc != nil {
				at = loc[1]
			}
			injected := make([]byte, 0, len(body)+len(injection))
			injected = append(injected, body[:at]...)
			injected = append(injected, injection...)
			injected = append(injected, body[at:]...)
			resp.Body = io.NopCloser(bytes.NewReader(injected))
			resp.ContentLength = int64(len(injected))
			h.Set("Content-Length", strconv.Itoa(len(injected)))
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			http.Error(w, "代理请求失败："+err.Error(), http.StatusBadGateway)
		},
	}
	srv := &http.Server{Handler: rp}
	go srv.Serve(ln)
	return proxyOrigin, func() { srv.Close() }, nil
}
