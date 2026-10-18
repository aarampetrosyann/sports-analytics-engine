.PHONY: build server sim test clean

build:
	cargo build --release --manifest-path simulator/Cargo.toml
	go -C server build -o ../bin/server .

# Ingestion server + dashboard on http://localhost:8080
server:
	go -C server run . -web ../web

# Edge simulator streaming to udp://127.0.0.1:9000
sim:
	cargo run --release --manifest-path simulator/Cargo.toml

test:
	cargo test --release --manifest-path simulator/Cargo.toml
	go -C server vet ./...

clean:
	rm -rf bin simulator/target
