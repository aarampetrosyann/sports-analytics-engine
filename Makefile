.PHONY: build server sim replay data test clean

# Replay options: make replay GAME=2 SPEED=4 START=58:00
GAME ?= 1
SPEED ?= 1
START ?= 00:00

METRICA_URL := https://raw.githubusercontent.com/metrica-sports/sample-data/master/data
METRICA_FILES := RawTrackingData_Home_Team.csv RawTrackingData_Away_Team.csv RawEventsData.csv

build:
	cargo build --release --manifest-path simulator/Cargo.toml
	go -C server build -o ../bin/server .

# Ingestion server + dashboard on http://localhost:8080
server:
	go -C server run . -web ../web

# Synthetic match streaming to udp://127.0.0.1:9000
sim:
	cargo run --release --manifest-path simulator/Cargo.toml

# Real recorded match (Metrica Sports sample game) streaming to udp://127.0.0.1:9000
replay: data/metrica/Sample_Game_$(GAME)
	cargo run --release --manifest-path simulator/Cargo.toml -- \
		--replay data/metrica/Sample_Game_$(GAME) --speed $(SPEED) --start $(START)

# Download Metrica sample games 1 and 2 (~65 MB each) into data/
data: data/metrica/Sample_Game_1 data/metrica/Sample_Game_2

data/metrica/Sample_Game_%:
	mkdir -p $@.tmp
	for f in $(METRICA_FILES); do \
		curl -fL --progress-bar -o $@.tmp/Sample_Game_$*_$$f $(METRICA_URL)/Sample_Game_$*/Sample_Game_$*_$$f || exit 1; \
	done
	mv $@.tmp $@

test:
	cargo test --release --manifest-path simulator/Cargo.toml
	go -C server vet ./...
	go -C server test ./...

clean:
	rm -rf bin simulator/target
