// Command server ingests edge tracking frames over UDP, computes live match
// metrics, and streams the results to dashboards over WebSockets.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"sync"
	"time"
)

func main() {
	udpAddr := flag.String("udp", ":9000", "UDP address to receive edge frames on")
	httpAddr := flag.String("http", ":8080", "HTTP address for the dashboard and WebSocket (empty to disable)")
	webDir := flag.String("web", "web", "directory containing the dashboard files")
	eventsOut := flag.String("events-out", "", "write every detected event to this file as JSON lines")
	quitIdle := flag.Duration("quit-after-idle", 0, "exit once frames stop arriving for this long (for offline runs)")
	flag.Parse()

	frames := make(chan Frame, 64)
	ingest := &IngestStats{}
	go func() {
		if err := listenUDP(*udpAddr, frames, ingest); err != nil {
			log.Fatalf("ingest: %v", err)
		}
	}()

	hub := NewHub()
	engine := NewEngine(ingest, hub)
	flush := func() {}
	if *eventsOut != "" {
		flush = logEvents(engine, *eventsOut)
	}
	go engine.Run(frames)

	if *quitIdle > 0 {
		go quitWhenIdle(ingest, frames, *quitIdle, flush)
	}

	if *httpAddr == "" {
		select {} // headless: run until quitWhenIdle exits
	}
	mux := http.NewServeMux()
	mux.Handle("/", noCache(http.FileServer(http.Dir(*webDir))))
	mux.HandleFunc("/ws", hub.ServeWS(engine.Welcome))

	log.Printf("http: dashboard on http://localhost%s (serving %s)", *httpAddr, *webDir)
	log.Fatal(http.ListenAndServe(*httpAddr, mux))
}

// logEvents appends each detected event to path as a JSON line and returns a
// function that flushes the file.
func logEvents(engine *Engine, path string) func() {
	f, err := os.Create(path)
	if err != nil {
		log.Fatalf("events-out: %v", err)
	}
	var mu sync.Mutex
	w := bufio.NewWriter(f)
	enc := json.NewEncoder(w)
	engine.OnEvent = func(ev Event) {
		mu.Lock()
		defer mu.Unlock()
		if err := enc.Encode(ev); err != nil {
			log.Printf("events-out: %v", err)
		}
	}
	log.Printf("events: logging to %s", path)
	return func() {
		mu.Lock()
		defer mu.Unlock()
		_ = w.Flush()
		_ = f.Close()
	}
}

// quitWhenIdle exits after frames have arrived and then stopped for idle.
func quitWhenIdle(ingest *IngestStats, frames chan Frame, idle time.Duration, flush func()) {
	last, since := uint64(0), time.Now()
	for range time.Tick(100 * time.Millisecond) {
		n := ingest.Packets.Load()
		if n != last || len(frames) > 0 {
			last, since = n, time.Now()
			continue
		}
		if n > 0 && time.Since(since) >= idle {
			flush()
			log.Printf("idle for %s after %d packets; exiting", idle, n)
			os.Exit(0)
		}
	}
}

// noCache makes browsers revalidate the dashboard files on every load, so a
// rebuilt dashboard is never hidden behind a stale cached copy.
func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}
