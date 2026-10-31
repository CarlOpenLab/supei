package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestListModels(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization = %q, want Bearer test-key", got)
		}
		w.Write([]byte(`{"data":[{"id":"gpt-4o"},{"id":"deepseek-chat"},{"id":""}]}`))
	}))
	defer srv.Close()

	got, err := LLMService{}.ListModels(context.Background(), srv.URL+"/v1/", "test-key")
	if err != nil {
		t.Fatalf("ListModels: %v", err)
	}
	if len(got) != 2 || got[0] != "gpt-4o" || got[1] != "deepseek-chat" {
		t.Fatalf("got %v, want [gpt-4o deepseek-chat]", got)
	}
}

func TestListModelsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte("bad key"))
	}))
	defer srv.Close()

	_, err := LLMService{}.ListModels(context.Background(), srv.URL, "")
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Fatalf("want status error, got %v", err)
	}
}
