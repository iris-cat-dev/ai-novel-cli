package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/gofrs/flock"
	"github.com/voocel/ainovel-cli/internal/store"
)

// Use the same lock file and exclusive flock as the existing application host.
// Never remove the lock file: unlinking it can create two independently held locks.
const lockFile = ".ainovel.lock"

func withLock(ctx context.Context, dir string, fn func() error) (err error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	lock := flock.New(filepath.Join(dir, lockFile), flock.SetPermissions(0o600))
	defer func() {
		if closeErr := lock.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close project lock: %w", closeErr))
		}
	}()
	locked, err := lock.TryLock()
	if err != nil {
		return fmt.Errorf("lock project %q: %w", dir, err)
	}
	if !locked {
		return fmt.Errorf("project %q is in use by another ainovel-cli instance", dir)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return fn()
}

func initializeProject(ctx context.Context, dir string, out io.Writer) error {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Check before creating a lock file in an unrelated nonempty directory,
	// then repeat under the lock to close the concurrent-init race.
	if err := requireEmptyDirectory(abs); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return fmt.Errorf("create project directory: %w", err)
	}
	return withLock(ctx, abs, func() error {
		if err := requireEmptyDirectory(abs); err != nil {
			return err
		}
		s := store.NewStore(abs)
		if err := s.Init(); err != nil {
			return fmt.Errorf("initialize project directories: %w", err)
		}
		if err := s.RunMeta.Init("default", "", ""); err != nil {
			return fmt.Errorf("initialize project metadata: %w", err)
		}
		if err := s.SaveProjectFormatVersion(store.CurrentProjectFormatVersion); err != nil {
			return fmt.Errorf("initialize project format: %w", err)
		}
		if err := s.Progress.Init(0); err != nil {
			return fmt.Errorf("initialize project progress: %w", err)
		}
		return writeJSON(out, map[string]any{
			"initialized":    true,
			"dir":            abs,
			"format_version": store.CurrentProjectFormatVersion,
		})
	})
}

func requireEmptyDirectory(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() != lockFile {
			return fmt.Errorf("init refuses nonempty directory %q; use status or call for an existing project", dir)
		}
	}
	return nil
}

func withProject(ctx context.Context, dir string, fn func(*store.Store) error) error {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	// Do not call Store.Init here: reads and tool calls must never create projects.
	if _, err := os.Stat(filepath.Join(abs, "meta", "progress.json")); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("project %q is not initialized; use init --dir PATH", abs)
		}
		return fmt.Errorf("read project progress: %w", err)
	}
	return withLock(ctx, abs, func() error {
		s := store.NewStore(abs)
		version, err := s.LoadProjectFormatVersion()
		if err != nil {
			return fmt.Errorf("read project format: %w", err)
		}
		if version != store.CurrentProjectFormatVersion {
			return fmt.Errorf("project format v%d is not supported; this CLI requires v%d and does not migrate projects; migrate with a compatible legacy release before using this CLI", version, store.CurrentProjectFormatVersion)
		}
		progress, err := s.Progress.Load()
		if err != nil {
			return fmt.Errorf("read project progress: %w", err)
		}
		if progress == nil || progress.Phase == "" {
			return fmt.Errorf("project %q has no valid initialized progress", abs)
		}
		if err := s.Checkpoints.InitError(); err != nil {
			return fmt.Errorf("read project checkpoints: %w", err)
		}
		return fn(s)
	})
}

func projectStatus(s *store.Store, out io.Writer) error {
	progress, err := s.Progress.Load()
	if err != nil {
		return err
	}
	book, err := s.Book.Load()
	if err != nil {
		return fmt.Errorf("read book metadata: %w", err)
	}
	missing, err := s.FoundationMissing()
	if err != nil {
		return fmt.Errorf("read foundation status: %w", err)
	}
	if missing == nil {
		missing = []string{}
	}
	warnings := s.CheckConsistency()
	if warnings == nil {
		warnings = []string{}
	}
	return writeJSON(out, map[string]any{
		"dir":                s.Dir(),
		"format_version":     store.CurrentProjectFormatVersion,
		"book":               book,
		"progress":           progress,
		"next_chapter":       progress.NextChapter(),
		"completed_chapters": len(progress.CompletedChapters),
		"foundation_missing": missing,
		"warnings":           warnings,
	})
}
