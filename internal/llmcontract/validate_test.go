package llmcontract

import "testing"

func TestValidateJSONFreeformContent(t *testing.T) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"content": map[string]any{"description": "Caller-supplied foundation data"},
		},
		"required":             []string{"content"},
		"additionalProperties": false,
	}
	for _, raw := range []string{
		`{"content":{"nested":{"name":"角色"}}}`,
		`{"content":[{"chapter":1}]}`,
	} {
		if err := ValidateJSON(schema, []byte(raw)); err != nil {
			t.Errorf("freeform content rejected: %v", err)
		}
	}
	for _, raw := range []string{`{}`, `{"content":"ok","unknown":true}`} {
		if err := ValidateJSON(schema, []byte(raw)); err == nil {
			t.Errorf("enclosing contract bypassed: %s", raw)
		}
	}
}
