package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/voocel/ainovel-cli/internal/entry/cli"
	buildversion "github.com/voocel/ainovel-cli/internal/version"
)

var (
	version = "dev"
	commit  = "unknown"
	date    = "unknown"
)

func main() {
	os.Exit(run(context.Background(), os.Args[1:]))
}

func run(ctx context.Context, args []string) int {
	if len(args) > 0 {
		switch args[0] {
		case "version", "--version", "-v":
			if len(args) != 1 {
				fmt.Fprintln(os.Stderr, "version 不接受其他参数")
				return 2
			}
			buildversion.Print(os.Stdout, versionInfo())
			return 0
		case "update":
			if len(args) > 2 || (len(args) == 2 && strings.HasPrefix(args[1], "-")) {
				fmt.Fprintln(os.Stderr, "用法: ainovel-cli update [VERSION]")
				return 2
			}
			target := ""
			if len(args) == 2 {
				target = args[1]
			}
			if err := runSelfUpdate(ctx, target); err != nil {
				fmt.Fprintf(os.Stderr, "update: %v\n", err)
				return 1
			}
			return 0
		}
	}
	return cli.Run(ctx, args, os.Stdin, os.Stdout, os.Stderr)
}

func versionInfo() buildversion.Info {
	return buildversion.Resolve(buildversion.Info{
		Version: version,
		Commit:  commit,
		Date:    date,
	})
}

func runSelfUpdate(ctx context.Context, target string) error {
	result, err := buildversion.Update(ctx, buildversion.UpdateOptions{
		Repo:           buildversion.DefaultRepo,
		BinaryName:     "ainovel-cli",
		TargetVersion:  target,
		CurrentVersion: versionInfo().Version,
	})
	if err != nil {
		return err
	}
	if !result.Updated {
		fmt.Printf("ainovel-cli 已是最新版本 %s\n", result.Version)
		return nil
	}
	fmt.Printf("ainovel-cli 已更新到 %s\n安装位置：%s\n", result.Version, result.Path)
	return nil
}
