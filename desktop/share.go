package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// —— 局域网分享：本机 HTTP 服务托管预览页，同一局域网内扫码即看 ——

// ShareInfo describes one published preview.
type ShareInfo struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	CreatedAt int64    `json:"createdAt"`
	URLs      []string `json:"urls"`
}

// ShareService publishes prototype previews on the local network.
type ShareService struct{}

const preferredSharePort = 7788

var (
	shareIDRe = regexp.MustCompile(`^[a-f0-9]{16}$`)
	shareMu   sync.Mutex
	sharePort int // 0 = 服务尚未启动
)

// sharesDir returns the directory holding published pages, creating it when missing.
func sharesDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "ai-design-canvas", "shares")
	return dir, os.MkdirAll(dir, 0o755)
}

// ensureShareServer lazily starts the LAN HTTP server (preferring a stable
// port so links survive restarts) and returns its port.
func ensureShareServer() (int, error) {
	shareMu.Lock()
	defer shareMu.Unlock()
	if sharePort != 0 {
		return sharePort, nil
	}
	dir, err := sharesDir()
	if err != nil {
		return 0, err
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", preferredSharePort))
	if err != nil {
		if ln, err = net.Listen("tcp", "0.0.0.0:0"); err != nil {
			return 0, err
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /s/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !shareIDRe.MatchString(id) {
			http.NotFound(w, r)
			return
		}
		b, err := os.ReadFile(filepath.Join(dir, id+".html"))
		if err != nil {
			http.Error(w, "分享已撤销或不存在", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(b)
	})
	go http.Serve(ln, mux)
	sharePort = ln.Addr().(*net.TCPAddr).Port
	return sharePort, nil
}

// lanURLs lists the share URL on every non-loopback IPv4 address, falling
// back to loopback when the machine has no network.
func lanURLs(port int, id string) []string {
	var urls []string
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipn.IP.To4()
			if ip == nil || ip.IsLinkLocalUnicast() {
				continue
			}
			urls = append(urls, fmt.Sprintf("http://%s:%d/s/%s", ip, port, id))
		}
	}
	if len(urls) == 0 {
		urls = append(urls, fmt.Sprintf("http://127.0.0.1:%d/s/%s", port, id))
	}
	return urls
}

// Publish stores the page and returns its LAN URLs.
func (ShareService) Publish(ctx context.Context, title string, html string) (ShareInfo, error) {
	port, err := ensureShareServer()
	if err != nil {
		return ShareInfo{}, fmt.Errorf("启动分享服务失败：%w", err)
	}
	dir, err := sharesDir()
	if err != nil {
		return ShareInfo{}, err
	}
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return ShareInfo{}, err
	}
	info := ShareInfo{ID: hex.EncodeToString(raw), Title: title, CreatedAt: time.Now().UnixMilli()}
	meta, err := json.Marshal(info)
	if err != nil {
		return ShareInfo{}, err
	}
	if err := os.WriteFile(filepath.Join(dir, info.ID+".html"), []byte(html), 0o644); err != nil {
		return ShareInfo{}, err
	}
	if err := os.WriteFile(filepath.Join(dir, info.ID+".json"), meta, 0o644); err != nil {
		return ShareInfo{}, err
	}
	info.URLs = lanURLs(port, info.ID)
	return info, nil
}

// List returns all published previews, newest first.
func (ShareService) List(ctx context.Context) ([]ShareInfo, error) {
	port, err := ensureShareServer()
	if err != nil {
		return nil, fmt.Errorf("启动分享服务失败：%w", err)
	}
	dir, err := sharesDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := []ShareInfo{}
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok || !shareIDRe.MatchString(id) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var info ShareInfo
		if json.Unmarshal(b, &info) != nil {
			continue
		}
		info.URLs = lanURLs(port, info.ID)
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out, nil
}

// Unpublish deletes a published preview; its links return 404 afterwards.
func (ShareService) Unpublish(ctx context.Context, id string) error {
	if !shareIDRe.MatchString(id) {
		return fmt.Errorf("无效的分享 id：%s", id)
	}
	dir, err := sharesDir()
	if err != nil {
		return err
	}
	for _, ext := range []string{".html", ".json"} {
		if err := os.Remove(filepath.Join(dir, id+ext)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
