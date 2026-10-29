package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"

	"github.com/egoist/mygo"
)

// —— 本地 Agent：用用户自己的 Claude Code / Codex 订阅生成设计或改代码 ——

// AgentInfo describes one locally installed coding-agent CLI.
type AgentInfo struct {
	Kind    string `json:"kind"`
	Path    string `json:"path"`
	Version string `json:"version"`
}

// AgentRunOptions configures one non-interactive agent run.
type AgentRunOptions struct {
	// Kind is "claude-code" or "codex".
	Kind  string `json:"kind"`
	Model string `json:"model,omitempty"`
	// Mode "design": no tools, empty temp cwd — the agent acts as a plain LLM.
	// Mode "code": runs inside Cwd and may edit files.
	Mode         string `json:"mode"`
	Cwd          string `json:"cwd,omitempty"`
	SystemPrompt string `json:"systemPrompt,omitempty"`
	Prompt       string `json:"prompt"`
}

// AgentEvent is one streamed agent event: "text" is answer output, "tool" a
// tool call summary, "log" a non-fatal notice.
type AgentEvent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

var agentBinaries = map[string]string{"claude-code": "claude", "codex": "codex"}

// AgentService runs local coding-agent CLIs and streams their output.
type AgentService struct{}

// Detect reports which supported agent CLIs are installed on PATH.
func (AgentService) Detect(ctx context.Context) ([]AgentInfo, error) {
	out := []AgentInfo{}
	for _, kind := range []string{"claude-code", "codex"} {
		path, err := exec.LookPath(agentBinaries[kind])
		if err != nil {
			continue
		}
		cmd := exec.CommandContext(ctx, path, "--version")
		prepareCmd(cmd)
		b, _ := cmd.Output()
		out = append(out, AgentInfo{Kind: kind, Path: path, Version: strings.TrimSpace(string(b))})
	}
	return out, nil
}

// Run executes the agent once and streams its events to the page. Closing
// the channel on the frontend cancels ctx, which kills the process tree.
func (AgentService) Run(ctx context.Context, opts AgentRunOptions, out *mygo.Channel[AgentEvent]) error {
	bin, ok := agentBinaries[opts.Kind]
	if !ok {
		return fmt.Errorf("不支持的 Agent 类型：%s", opts.Kind)
	}
	path, err := exec.LookPath(bin)
	if err != nil {
		return fmt.Errorf("未找到 %s 命令，请先安装并确保在 PATH 中", bin)
	}

	cwd := opts.Cwd
	if opts.Mode == "design" {
		tmp, err := os.MkdirTemp("", "dc-agent-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(tmp)
		cwd = tmp
	} else if cwd == "" {
		return errors.New("代码模式需要指定仓库目录")
	}

	var args []string
	var parse func(line []byte, emit func(AgentEvent) error) error
	prompt := opts.Prompt
	switch opts.Kind {
	case "claude-code":
		args = []string{"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence"}
		if opts.Mode == "design" {
			args = append(args, "--tools", "")
		} else {
			args = append(args, "--permission-mode", "acceptEdits")
		}
		if opts.SystemPrompt != "" {
			f, err := writeTempFile("dc-system-*.md", opts.SystemPrompt)
			if err != nil {
				return err
			}
			defer os.Remove(f)
			// design 模式替换掉编码助手人设；code 模式保留默认能力，只追加约束
			flag := "--system-prompt-file"
			if opts.Mode != "design" {
				flag = "--append-system-prompt-file"
			}
			args = append(args, flag, f)
		}
		parse = parseClaudeLine
	case "codex":
		args = []string{"exec", "--json", "--skip-git-repo-check"}
		if opts.Mode == "design" {
			args = append(args, "--sandbox", "read-only")
		} else {
			args = append(args, "--sandbox", "workspace-write")
		}
		if opts.SystemPrompt != "" {
			prompt = opts.SystemPrompt + "\n\n---\n\n" + prompt
		}
		parse = parseCodexLine
	}
	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
	}
	if opts.Kind == "codex" {
		args = append(args, "-")
	}

	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Dir = cwd
	cmd.Stdin = strings.NewReader(prompt)
	prepareCmd(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr := &tailBuffer{max: 4096}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动 %s 失败：%w", bin, err)
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	var runErr error
	for scanner.Scan() {
		if err := parse(scanner.Bytes(), out.Send); err != nil {
			runErr = err
			break
		}
	}
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if runErr != nil {
		return runErr
	}
	if waitErr != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = waitErr.Error()
		}
		return fmt.Errorf("%s 异常退出：%s", bin, msg)
	}
	return scanner.Err()
}

// claudeLine covers the stream-json event fields we consume.
type claudeLine struct {
	Type    string `json:"type"`
	IsError bool   `json:"is_error"`
	Result  string `json:"result"`
	Event   struct {
		Type  string `json:"type"`
		Delta struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
	} `json:"event"`
	Message struct {
		Content []struct {
			Type  string          `json:"type"`
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		} `json:"content"`
	} `json:"message"`
}

// parseClaudeLine turns one Claude Code stream-json line into events:
// text deltas stream token by token, tool_use blocks become tool summaries.
func parseClaudeLine(line []byte, emit func(AgentEvent) error) error {
	var l claudeLine
	if json.Unmarshal(line, &l) != nil {
		return nil
	}
	switch l.Type {
	case "stream_event":
		if l.Event.Type == "content_block_delta" && l.Event.Delta.Type == "text_delta" && l.Event.Delta.Text != "" {
			return emit(AgentEvent{Type: "text", Text: l.Event.Delta.Text})
		}
	case "assistant":
		for _, c := range l.Message.Content {
			if c.Type == "tool_use" {
				if err := emit(AgentEvent{Type: "tool", Text: c.Name + " " + summarizeInput(c.Input)}); err != nil {
					return err
				}
			}
		}
	case "result":
		if l.IsError {
			return fmt.Errorf("Claude Code 返回错误：%s", l.Result)
		}
	}
	return nil
}

// codexLine covers the `codex exec --json` event fields we consume.
type codexLine struct {
	Type string `json:"type"`
	Item struct {
		Type    string `json:"type"`
		Text    string `json:"text"`
		Message string `json:"message"`
		Command string `json:"command"`
		Changes []struct {
			Path string `json:"path"`
			Kind string `json:"kind"`
		} `json:"changes"`
	} `json:"item"`
	Message string `json:"message"`
	Error   struct {
		Message string `json:"message"`
	} `json:"error"`
}

// parseCodexLine turns one Codex JSONL event into events. Codex exec only
// reports completed items, so text arrives one message at a time.
func parseCodexLine(line []byte, emit func(AgentEvent) error) error {
	var l codexLine
	if json.Unmarshal(line, &l) != nil {
		return nil
	}
	switch l.Type {
	case "item.completed":
		switch l.Item.Type {
		case "agent_message":
			return emit(AgentEvent{Type: "text", Text: l.Item.Text})
		case "command_execution":
			return emit(AgentEvent{Type: "tool", Text: "Shell " + l.Item.Command})
		case "file_change":
			for _, c := range l.Item.Changes {
				if err := emit(AgentEvent{Type: "tool", Text: "Edit " + c.Kind + " " + c.Path}); err != nil {
					return err
				}
			}
		case "error":
			return emit(AgentEvent{Type: "log", Text: l.Item.Message})
		}
	case "turn.failed":
		return fmt.Errorf("Codex 返回错误：%s", l.Error.Message)
	case "error":
		return fmt.Errorf("Codex 返回错误：%s", l.Message)
	}
	return nil
}

// summarizeInput picks the most telling field of a tool input for display.
func summarizeInput(raw json.RawMessage) string {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return ""
	}
	for _, k := range []string{"file_path", "command", "pattern", "path", "url"} {
		if v, ok := m[k].(string); ok {
			if len(v) > 120 {
				v = v[:120] + "…"
			}
			return v
		}
	}
	return ""
}

// writeTempFile writes content to a new uniquely named temp file and returns its path.
func writeTempFile(pattern, content string) (string, error) {
	f, err := os.CreateTemp("", pattern)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// tailBuffer keeps only the last max bytes written (stderr for error messages).
type tailBuffer struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}
