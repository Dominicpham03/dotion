# Build context is the repo root (see deploy/docker-compose.yml).

# 1. Build the web UI
FROM node:22-alpine AS ui
WORKDIR /src/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build:web            # outputs to ../server/internal/webui/dist

# 2. Build the Go binary with the UI embedded
FROM golang:1.26 AS build
WORKDIR /src
COPY go.work ./
COPY shared/ shared/
COPY server/ server/
# go.work lists ./desktop; its go.mod is enough
COPY desktop/go.mod desktop/go.sum* desktop/
COPY --from=ui /src/server/internal/webui/dist server/internal/webui/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/diary ./server/cmd/diary

# 3. Minimal runtime image (~20 MB), runs as non-root
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/diary /diary
VOLUME /data
ENV DIARY_DATA_DIR=/data
ENTRYPOINT ["/diary"]
