package main

import "testing"

func TestParseClaudeLine(t *testing.T) {
	var got []AgentEvent
	emit := func(e AgentEvent) error { got = append(got, e); return nil }
	lines := []string{
		`{"type":"system","subtype":"init"}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi "}}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/App.vue"}}]}}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}}`,
		`not json`,
	}
	for _, l := range lines {
		if err := parseClaudeLine([]byte(l), emit); err != nil {
			t.Fatal(err)
		}
	}
	want := []AgentEvent{{Type: "text", Text: "hi "}, {Type: "tool", Text: "Edit src/App.vue"}}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("got %+v, want %+v", got, want)
	}
	if err := parseClaudeLine([]byte(`{"type":"result","is_error":true,"result":"auth failed"}`), emit); err == nil {
		t.Error("error result should fail the run")
	}
}

func TestParseCodexLine(t *testing.T) {
	var got []AgentEvent
	emit := func(e AgentEvent) error { got = append(got, e); return nil }
	lines := []string{
		`{"type":"thread.started","thread_id":"x"}`,
		`{"type":"item.completed","item":{"type":"error","message":"config ignored"}}`,
		`{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}`,
		`{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"a.css","kind":"update"}]}}`,
		`{"type":"item.completed","item":{"type":"agent_message","text":"done"}}`,
	}
	for _, l := range lines {
		if err := parseCodexLine([]byte(l), emit); err != nil {
			t.Fatal(err)
		}
	}
	want := []AgentEvent{
		{Type: "log", Text: "config ignored"},
		{Type: "tool", Text: "Shell ls"},
		{Type: "tool", Text: "Edit update a.css"},
		{Type: "text", Text: "done"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("event %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
	if err := parseCodexLine([]byte(`{"type":"turn.failed","error":{"message":"quota"}}`), emit); err == nil {
		t.Error("turn.failed should fail the run")
	}
}
