-include deploy/.env
TLS_MODE ?= tailscale
COMPOSE  := docker compose -f deploy/docker-compose.yml

.PHONY: dev dev-ui test build desktop desktop-dev android generate lint up down logs

# Server on 127.0.0.1:8080 with a local data dir. Run `make dev-ui` in a second terminal.
dev:
	cd server && DIARY_DATA_DIR=../.data DIARY_OWNER_LOGIN=dev@local go run ./cmd/diary

dev-ui:
	cd ui && npm run dev:web

test:
	go test ./shared/... ./server/... ./desktop/...
	cd ui && npm test

# Server binary with the web UI embedded → bin/diary
build:
	cd ui && npm ci && npm run build:web
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/diary ./server/cmd/diary

# Windows installer → desktop/build/bin (needs the Wails CLI)
desktop:
	cd desktop && wails build -nsis

desktop-dev:
	cd desktop && wails dev

# Android debug APK → mobile/android/app/build/outputs/apk/debug (needs JDK 17 and the Android SDK)
android:
	cd ui && npm run build:mobile
	# cap sync regenerates this folder; removing it first avoids EPERM errors inside OneDrive folders
	rm -rf mobile/android/capacitor-cordova-android-plugins
	cd mobile && npx cap sync android && cd android && ./gradlew assembleDebug

generate:
	cd server && sqlc generate

lint:
	golangci-lint run ./shared/... ./server/... ./desktop/...
	cd ui && npm run lint

up:
	$(COMPOSE) --profile $(TLS_MODE) up -d --build

down:
	$(COMPOSE) --profile $(TLS_MODE) down

logs:
	$(COMPOSE) --profile $(TLS_MODE) logs -f
