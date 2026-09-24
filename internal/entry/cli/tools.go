package cli

import (
	"context"
	"encoding/json"

	"github.com/voocel/ainovel-cli/internal/store"
	"github.com/voocel/ainovel-cli/internal/tools"
)

// tool is the deterministic surface only: no agent runner or model is involved.
type tool interface {
	Name() string
	Description() string
	Schema() map[string]any
	Execute(context.Context, json.RawMessage) (json.RawMessage, error)
	ReadOnly(json.RawMessage) bool
}

type descriptor struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	ReadOnly    bool           `json:"read_only"`
	Schema      map[string]any `json:"schema"`
}

func toolset(s *store.Store, style string, refs tools.References) []tool {
	stats := tools.NewStyleStatsIndex(s)
	return []tool{
		tools.NewAuditFoundationTool(s),
		tools.NewCheckConsistencyTool(s),
		tools.NewCommitChapterTool(s, stats),
		tools.NewDraftChapterTool(s),
		tools.NewEditChapterTool(s),
		tools.NewExpandNextArcTool(s),
		tools.NewContextTool(s, refs, style, stats),
		tools.NewPlanChapterTool(s),
		tools.NewReadChapterTool(s),
		tools.NewReopenBookTool(s),
		tools.NewResolveOutlineFeedbackTool(s),
		tools.NewReviseOutlineTool(s),
		tools.NewSaveArcSummaryTool(s),
		tools.NewSaveBookTool(s),
		tools.NewSaveFoundationTool(s),
		tools.NewSaveReviewTool(s),
		tools.NewSaveVolumeSummaryTool(s),
	}
}

func findTool(all []tool, name string) tool {
	for _, candidate := range all {
		if candidate.Name() == name {
			return candidate
		}
	}
	return nil
}
