package main

import (
	"encoding/json"
	"log"
	"net"
	"sync/atomic"
	"time"
)

// Frame is one tracking sample from the edge device.
type Frame struct {
	Seq     uint64        `json:"seq"`
	TS      int64         `json:"ts"` // unix ms when the edge produced the frame
	Ball    Point         `json:"ball"`
	Players []PlayerFrame `json:"players"`

	recvAt time.Time
}

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type PlayerFrame struct {
	ID   int     `json:"id"`
	Team int     `json:"team"`
	Num  int     `json:"num"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
}

// IngestStats is written by the UDP goroutine and read by the engine.
type IngestStats struct {
	Packets      atomic.Uint64
	DecodeErrors atomic.Uint64
	ChannelDrops atomic.Uint64
}

// listenUDP decodes datagrams into frames and hands them to the engine.
// If the engine falls behind, frames are dropped rather than queued so the
// dashboard never shows stale positions.
func listenUDP(addr string, out chan<- Frame, stats *IngestStats) error {
	conn, err := net.ListenPacket("udp", addr)
	if err != nil {
		return err
	}
	defer conn.Close()
	if uc, ok := conn.(*net.UDPConn); ok {
		_ = uc.SetReadBuffer(1 << 20)
	}
	log.Printf("ingest: listening for edge frames on udp %s", conn.LocalAddr())

	buf := make([]byte, 64*1024)
	for {
		n, _, err := conn.ReadFrom(buf)
		if err != nil {
			return err
		}
		recv := time.Now()
		stats.Packets.Add(1)

		var f Frame
		if err := json.Unmarshal(buf[:n], &f); err != nil {
			stats.DecodeErrors.Add(1)
			continue
		}
		f.recvAt = recv

		select {
		case out <- f:
		default:
			stats.ChannelDrops.Add(1)
		}
	}
}
