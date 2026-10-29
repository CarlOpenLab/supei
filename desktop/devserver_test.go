package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInjectingProxy(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
			w.Header().Set("X-Frame-Options", "DENY")
			io.WriteString(w, `<!doctype html><html><head lang="en"><title>t</title></head><body><header>h</header></body></html>`)
		case "/no-head":
			w.Header().Set("Content-Type", "text/html")
			io.WriteString(w, `<header>only header</header>`)
		case "/app.js":
			w.Header().Set("Content-Type", "text/javascript")
			io.WriteString(w, `console.log("<head>")`)
		case "/go":
			http.Redirect(w, r, "http://"+r.Host+"/", http.StatusFound)
		}
	}))
	defer target.Close()

	origin, stop, err := startInjectingProxy(target.URL, "window.__x=1")
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	get := func(path string) (*http.Response, string) {
		t.Helper()
		resp, err := client.Get(origin + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp, string(b)
	}

	resp, body := get("/")
	if want := `<head lang="en"><script>window.__x=1</script><title>`; !strings.Contains(body, want) {
		t.Errorf("bridge not injected right after <head>: %s", body)
	}
	if strings.Contains(body, "<header><script>") {
		t.Errorf("injected into <header>: %s", body)
	}
	if resp.Header.Get("X-Frame-Options") != "" || resp.Header.Get("Content-Security-Policy") != "" {
		t.Errorf("framing headers not stripped: %v", resp.Header)
	}
	if resp.ContentLength != int64(len(body)) {
		t.Errorf("content length %d != body %d", resp.ContentLength, len(body))
	}

	if _, body := get("/no-head"); !strings.HasPrefix(body, "<script>window.__x=1</script><header>") {
		t.Errorf("headless document should get the script prepended: %s", body)
	}
	if _, body := get("/app.js"); body != `console.log("<head>")` {
		t.Errorf("non-HTML response must pass through untouched: %s", body)
	}
	if resp, _ := get("/go"); resp.Header.Get("Location") != origin+"/" {
		t.Errorf("redirect not rewritten to proxy origin: %q", resp.Header.Get("Location"))
	}
}
