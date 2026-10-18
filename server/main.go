// Command server ingests edge tracking frames over UDP, computes live match
// metrics, and streams the results to dashboards over WebSockets.
package main

import (
	"flag"
	"log"
	"net/http"
)

func main() {
	udpAddr := flag.String("udp", ":9000", "UDP address to receive edge frames on")
	httpAddr := flag.String("http", ":8080", "HTTP address for the dashboard and WebSocket")
	webDir := flag.String("web", "web", "directory containing the dashboard files")
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
	go engine.Run(frames)

	mux := http.NewServeMux()
	mux.Handle("/", noCache(http.FileServer(http.Dir(*webDir))))
	mux.HandleFunc("/ws", hub.ServeWS(engine.Welcome))

	log.Printf("http: dashboard on http://localhost%s (serving %s)", *httpAddr, *webDir)
	log.Fatal(http.ListenAndServe(*httpAddr, mux))
}

// noCache makes browsers revalidate the dashboard files on every load, so a
// rebuilt dashboard is never hidden behind a stale cached copy.
func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}
