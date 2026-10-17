package core

import (
	"encoding/json"
	"fmt"
	"strings"

	"diary/shared/model"
)

// NamedValue is one database property of a record, ready to show: option ids
// are turned into option names and relation ids into page titles.
type NamedValue struct {
	Name   string
	Type   string
	Values []string
}

type dbSchema struct {
	Schema struct {
		Properties []struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Type    string `json:"type"`
			Options []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"options"`
		} `json:"properties"`
	} `json:"schema"`
}

// RecordProperties lists rec's property values in the order db defines them.
// titleOf names a related page; it returns false for unknown ids.
func RecordProperties(rec, db model.Entry, titleOf func(id string) (string, bool)) []NamedValue {
	if db.Kind != model.KindDatabase {
		return nil
	}
	var schema dbSchema
	var r struct {
		Props map[string]json.RawMessage `json:"props"`
	}
	if json.Unmarshal(db.Meta, &schema) != nil || json.Unmarshal(rec.Meta, &r) != nil {
		return nil
	}
	var out []NamedValue
	for _, p := range schema.Schema.Properties {
		raw, ok := r.Props[p.ID]
		if !ok {
			continue
		}
		option := map[string]string{}
		for _, o := range p.Options {
			option[o.ID] = o.Name
		}
		var value any
		_ = json.Unmarshal(raw, &value)
		var parts []string
		switch v := value.(type) {
		case string:
			parts = []string{v}
		case []any:
			for _, x := range v {
				if s, ok := x.(string); ok {
					parts = append(parts, s)
				}
			}
		case bool:
			parts = []string{map[bool]string{true: "yes", false: "no"}[v]}
		case float64:
			parts = []string{fmt.Sprint(v)}
		}
		for i, s := range parts {
			if name, ok := option[s]; ok {
				parts[i] = name
			} else if model.IsUUID(s) && titleOf != nil {
				if t, ok := titleOf(strings.ToLower(s)); ok {
					parts[i] = t
				}
			}
		}
		if len(parts) > 0 && parts[0] != "" {
			out = append(out, NamedValue{Name: p.Name, Type: p.Type, Values: parts})
		}
	}
	return out
}
