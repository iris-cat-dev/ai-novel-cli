// Package cli exposes the existing deterministic writing tools to external callers.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/voocel/ainovel-cli/assets"
	"github.com/voocel/ainovel-cli/internal/llmcontract"
	"github.com/voocel/ainovel-cli/internal/store"
	"github.com/voocel/ainovel-cli/internal/tools"
)

const help = `ainovel-cli — model-free novel project tools

Usage:
  ainovel-cli init --dir PATH
  ainovel-cli status --dir PATH
  ainovel-cli tools
  ainovel-cli schema NAME
  ainovel-cli call NAME --dir PATH [--input FILE|-]
  ainovel-cli --help
  ainovel-cli version
  ainovel-cli update [VERSION]

PATH is the project storage root (meta/, drafts/, chapters/).
init accepts only a new or empty directory and never overwrites a project.
call reads one JSON object from stdin by default; --input selects a UTF-8 JSON file.
Tool results and project status are JSON on stdout; errors go to stderr.
Project commands require no model configuration, credentials, or network access.
The explicit update command downloads a release from the network.
Existing projects must already use the current storage format; no migration runs.
`

// Run executes one command and returns a process exit code. It does not bootstrap
// an application host, start agents, load model configuration, or contact a model.
func Run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if err := run(ctx, args, stdin, stdout); err != nil {
		fmt.Fprintf(stderr, "ainovel-cli: %v\n", err)
		return 1
	}
	return 0
}

func run(ctx context.Context, args []string, stdin io.Reader, stdout io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(args) == 0 || (len(args) == 1 && (args[0] == "--help" || args[0] == "-h" || args[0] == "help")) {
		_, err := io.WriteString(stdout, help)
		return err
	}
	command := args[0]
	args = args[1:]
	switch command {
	case "tools":
		if len(args) != 0 {
			return fmt.Errorf("tools takes no arguments")
		}
		all := toolset(&store.Store{}, "", tools.References{})
		descriptors := make([]descriptor, 0, len(all))
		for _, t := range all {
			descriptors = append(descriptors, descriptor{t.Name(), t.Description(), t.ReadOnly(nil), t.Schema()})
		}
		return writeJSON(stdout, descriptors)
	case "schema":
		if len(args) != 1 {
			return fmt.Errorf("usage: schema NAME")
		}
		t := findTool(toolset(&store.Store{}, "", tools.References{}), args[0])
		if t == nil {
			return fmt.Errorf("unknown tool %q; use tools to list available tools", args[0])
		}
		return writeJSON(stdout, t.Schema())
	case "init", "status", "call":
		name := ""
		if command == "call" {
			if len(args) == 0 || strings.HasPrefix(args[0], "-") {
				return fmt.Errorf("usage: call NAME --dir PATH [--input FILE|-]")
			}
			name, args = args[0], args[1:]
		}
		dir, input, err := parseOptions(command, args)
		if errors.Is(err, flag.ErrHelp) {
			_, err = io.WriteString(stdout, help)
			return err
		}
		if err != nil {
			return err
		}
		if command == "init" {
			return initializeProject(ctx, dir, stdout)
		}
		var raw json.RawMessage
		if command == "call" {
			t := findTool(toolset(&store.Store{}, "", tools.References{}), name)
			if t == nil {
				return fmt.Errorf("unknown tool %q; use tools to list available tools", name)
			}
			raw, err = readInput(input, stdin)
			if err != nil {
				return err
			}
			if err := llmcontract.ValidateJSON(t.Schema(), raw); err != nil {
				return fmt.Errorf("invalid %s input: %w", name, err)
			}
		}
		return withProject(ctx, dir, func(s *store.Store) error {
			if command == "status" {
				return projectStatus(s, stdout)
			}
			var style string
			var refs tools.References
			if name == "novel_context" {
				style = "default"
				meta, err := s.RunMeta.Load()
				if err != nil {
					return fmt.Errorf("load project metadata: %w", err)
				}
				if meta != nil && meta.Style != "" {
					style = meta.Style
				}
				refs = assets.Load(style, assets.LoadOptions{}).References
			}
			t := findTool(toolset(s, style, refs), name)
			result, err := t.Execute(ctx, raw)
			if err != nil {
				return err
			}
			// Preserve the tool's JSON instead of wrapping or re-encoding it.
			if _, err := stdout.Write(result); err != nil {
				return err
			}
			_, err = io.WriteString(stdout, "\n")
			return err
		})
	default:
		return fmt.Errorf("unknown command %q; use --help for usage", command)
	}
}

func parseOptions(command string, args []string) (dir, input string, err error) {
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&dir, "dir", "", "project storage root")
	if command == "call" {
		flags.StringVar(&input, "input", "-", "JSON file or - for stdin")
	}
	if err = flags.Parse(args); err != nil {
		return "", "", err
	}
	if flags.NArg() != 0 {
		return "", "", fmt.Errorf("unexpected argument %q", flags.Arg(0))
	}
	if strings.TrimSpace(dir) == "" {
		return "", "", fmt.Errorf("%s requires --dir PATH", command)
	}
	if command == "call" && input == "" {
		return "", "", fmt.Errorf("--input requires a file path or -")
	}
	return dir, input, nil
}

func readInput(path string, stdin io.Reader) (json.RawMessage, error) {
	if path == "-" {
		return io.ReadAll(stdin)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read input: %w", err)
	}
	return data, nil
}

func writeJSON(out io.Writer, value any) error {
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}
