// Package migrations embeds the goose SQL files into the server binary.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
