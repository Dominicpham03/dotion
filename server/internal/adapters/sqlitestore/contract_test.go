package sqlitestore

import (
	"testing"

	"diary/server/internal/core"
	"diary/server/internal/core/storetest"
)

func TestStoreContract(t *testing.T) {
	storetest.Run(t, func(t *testing.T) core.Store { return openTemp(t) })
}
