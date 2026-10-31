package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/egoist/mygo"
)

// Greeter is callable from the frontend: `mygo generate` turns its methods
// into typed TypeScript functions in ../src/services/mygo-client.ts.
type Greeter struct{}

// Ping proves the IPC bridge works.
func (Greeter) Ping() string {
	return "desktop-bridge-ok"
}

// —— LLM 流式代理：把 OpenAI 兼容请求放在 Go 侧发，彻底绕开浏览器 CORS ——

// ChatMessage is one entry of the messages array.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// LLMOptions carries everything needed for one /chat/completions call.
type LLMOptions struct {
	BaseURL     string        `json:"baseURL"`
	APIKey      string        `json:"apiKey"`
	Model       string        `json:"model"`
	Messages    []ChatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	// ReasoningEffort 为空时不传；部分服务商支持 high/medium/low 思考档位。
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
}

// StreamDelta is one streamed piece: a token, or a terminal error.
type StreamDelta struct {
	Delta string `json:"delta,omitempty"`
	Err   string `json:"err,omitempty"`
}

type chatCompletionChunk struct {
	Choices []struct {
		Delta struct {
			Content string `json:"content"`
		} `json:"delta"`
	} `json:"choices"`
}

type completionRequest struct {
	Model           string        `json:"model"`
	Messages        []ChatMessage `json:"messages"`
	Stream          bool          `json:"stream"`
	Temperature     float64       `json:"temperature"`
	ReasoningEffort string        `json:"reasoning_effort,omitempty"`
}

// LLMService is the frontend-facing name of the streaming proxy.
type LLMService struct{}

// Stream calls the OpenAI-compatible chat/completions endpoint and streams
// token deltas to the page. Returning a non-nil error rejects the promise on
// the frontend.
func (LLMService) Stream(ctx context.Context, opts LLMOptions, out *mygo.Channel[StreamDelta]) error {
	payload, err := json.Marshal(completionRequest{
		Model:           opts.Model,
		Messages:        opts.Messages,
		Stream:          true,
		Temperature:     opts.Temperature,
		ReasoningEffort: opts.ReasoningEffort,
	})
	if err != nil {
		return err
	}
	url := strings.TrimRight(opts.BaseURL, "/") + "/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if opts.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+opts.APIKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("无法连接到模型服务：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("模型服务返回 %d：%s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			break
		}
		var chunk chatCompletionChunk
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue
		}
		if len(chunk.Choices) == 0 {
			continue
		}
		if d := chunk.Choices[0].Delta.Content; d != "" {
			if err := out.Send(StreamDelta{Delta: d}); err != nil {
				return err // 页面已关闭或取消了迭代
			}
		}
	}
	return scanner.Err()
}

// modelEntry is one entry of an OpenAI-compatible /models response.
type modelEntry struct {
	ID string `json:"id"`
}

type modelListResponse struct {
	Data []modelEntry `json:"data"`
}

// ListModels GETs the OpenAI-compatible {baseURL}/models endpoint and returns
// the model ids, so the settings UI can offer real model names (e.g. from a
// local gateway like Magpie) instead of free text. Desktop-only CORS escape.
func (LLMService) ListModels(ctx context.Context, baseURL string, apiKey string) ([]string, error) {
	url := strings.TrimRight(baseURL, "/") + "/models"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法连接到模型服务：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("模型服务返回 %d：%s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	var parsed modelListResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1024*1024)).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("响应不是 OpenAI 兼容的模型列表：%w", err)
	}
	out := make([]string, 0, len(parsed.Data))
	for _, m := range parsed.Data {
		if m.ID != "" {
			out = append(out, m.ID)
		}
	}
	return out, nil
}

// —— 系统集成：原型外链用默认浏览器打开，不在画布 iframe 里跳转 ——

// SysService wraps small OS integrations for the frontend.
type SysService struct{}

// OpenURL opens an http(s) link in the user's default browser. Prototype
// links are intercepted by the bridge and routed here so the canvas iframe
// never navigates away ("套娃").
func (SysService) OpenURL(_ context.Context, rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return fmt.Errorf("仅支持打开 http(s) 链接：%s", rawURL)
	}
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", u.String()).Start()
	case "darwin":
		return exec.Command("open", u.String()).Start()
	default:
		return exec.Command("xdg-open", u.String()).Start()
	}
}

// —— 存储：原生保存对话框 + 本地文件读取 ——

// StorageService gives the frontend native file abilities the webview lacks.
type StorageService struct{}

// SaveHTML opens a native save dialog and writes the prototype to disk.
// Returns the path written, or an empty string when the user canceled.
func (StorageService) SaveHTML(ctx context.Context, title string, html string) (string, error) {
	path, err := mygo.Dialog.Save(mygo.SaveDialogOptions{
		Title:             title,
		DefaultPath:       "原型.html",
		CreateDirectories: true,
		Filters: []mygo.FileFilter{
			{Name: "HTML", Extensions: []string{"html"}},
		},
	})
	if err != nil {
		if err == mygo.ErrCanceled {
			return "", nil
		}
		return "", err
	}
	if path == "" {
		return "", nil
	}
	if !strings.HasSuffix(strings.ToLower(path), ".html") {
		path += ".html"
	}
	if err := os.WriteFile(path, []byte(html), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// StyleFile is a design style pack read from disk.
type StyleFile struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

// PluginDir returns the user's plugin directory, creating it when missing.
// Files dropped here (.md / .json plugin packs) are auto-loaded on startup.
func (StorageService) PluginDir(ctx context.Context) (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "ai-design-canvas", "plugins")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// ReadPluginDir reads every .md/.json plugin pack in the plugin directory.
func (StorageService) ReadPluginDir(ctx context.Context) ([]StyleFile, error) {
	dir, err := (StorageService{}).PluginDir(ctx)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]StyleFile, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := strings.ToLower(e.Name())
		if !strings.HasSuffix(name, ".md") && !strings.HasSuffix(name, ".json") && !strings.HasSuffix(name, ".txt") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		out = append(out, StyleFile{Name: e.Name(), Content: string(b)})
	}
	return out, nil
}

// WatchPluginDir watches the user plugin directory and streams a signal to
// the page whenever a .md/.json plugin pack changes, so the frontend can
// hot-reload plugins without restarting.
func (StorageService) WatchPluginDir(ctx context.Context, out *mygo.Channel[string]) error {
	dir, err := (StorageService{}).PluginDir(ctx)
	if err != nil {
		return err
	}
	watcher, err := mygo.WatchFiles(ctx, dir, mygo.FileWatchOptions{})
	if err != nil {
		return err
	}
	defer watcher.Close()
	for {
		events, err := watcher.Next(ctx)
		if err != nil {
			return err
		}
		for _, e := range events {
			if e.IsDir {
				continue
			}
			name := strings.ToLower(e.Path)
			if strings.HasSuffix(name, ".md") || strings.HasSuffix(name, ".json") || strings.HasSuffix(name, ".txt") {
				if err := out.Send(e.Path); err != nil {
					return err
				}
				break // 一次目录变更只推一个信号
			}
		}
	}
}

// ReadStyleFiles opens native file picker(s) and returns the raw contents of
// the chosen .md/.json style packs.
func (StorageService) ReadStyleFiles(ctx context.Context) ([]StyleFile, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Title:    "选择风格包（.md / .json）",
		Multiple: true,
		Filters: []mygo.FileFilter{
			{Name: "风格包", Extensions: []string{"md", "json", "txt"}},
		},
	})
	if err != nil {
		if err == mygo.ErrCanceled {
			return nil, nil
		}
		return nil, err
	}
	out := make([]StyleFile, 0, len(paths))
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		out = append(out, StyleFile{Name: p, Content: string(b)})
	}
	return out, nil
}

func main() {
	// WebView2 硬件加速在部分显卡/驱动上表现为白屏：默认禁用 GPU 渲染。
	// 用户若显式设置了该变量，尊重用户的值。
	if os.Getenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") == "" {
		os.Setenv("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--disable-gpu")
	}

	mygo.Bind(Greeter{}, LLMService{}, StorageService{}, AgentService{}, DevServerService{}, ShareService{}, SysService{})

	mygo.App.WhenReady(func() {
		mygo.NewWindow(mygo.WindowOptions{
			Title:           "AI 原型画布",
			Width:           1440,
			Height:          900,
			MinWidth:        960,
			MinHeight:       600,
			BackgroundColor: "#e9e6df",
			StateKey:        "main",
			URL:             "/",
		})
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
