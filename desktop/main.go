// Command desktop is the Wails desktop app. Build with `wails build`, run
// with `wails dev`; a plain `go build` only checks that it compiles.
package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// frontend/dist is filled by `npm run build:desktop` in ui/.
//
//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()
	err := wails.Run(&options.App{
		Title:         "Dotion",
		Width:         1100,
		Height:        760,
		MinWidth:      480,
		MinHeight:     400,
		AssetServer:   &assetserver.Options{Assets: assets, Handler: app.blobHandler()},
		OnStartup:     app.startup,
		OnBeforeClose: app.beforeClose,
		OnShutdown:    app.shutdown,
		// Two windows must never share one local database.
		SingleInstanceLock: &options.SingleInstanceLock{UniqueId: "dotion-desktop-5d2f8c1e"},
		Bind:               []interface{}{app},
	})
	if err != nil {
		log.Fatal(err)
	}
}
