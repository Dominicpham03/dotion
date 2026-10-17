package main

import (
	"net"
	"net/http"
	"time"
)

// healthcheck implements `diary healthcheck`, used by the Docker healthcheck
// so the distroless image needs no curl. It returns the process exit code.
func healthcheck(addr string) int {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return 1
	}
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "127.0.0.1"
	}
	client := &http.Client{Timeout: 2 * time.Second}
	res, err := client.Get("http://" + net.JoinHostPort(host, port) + "/v1/health")
	if err != nil {
		return 1
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
