// Independent oracle: Go path.Match (POSIX COPY) and Moby's native ignore matcher.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/moby/patternmatcher"
	"github.com/moby/patternmatcher/ignorefile"
)

type input struct {
	Kind    string `json:"kind"`
	Pattern string `json:"pattern"`
	Path    string `json:"path"`
}

func main() {
	var inputs []input
	if err := json.NewDecoder(os.Stdin).Decode(&inputs); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	outputs := make([]int, len(inputs))
	for i, in := range inputs {
		var matched bool
		var err error
		if in.Kind == "copy" {
			matched, err = path.Match(in.Pattern, in.Path)
		} else {
			var patterns []string
			patterns, err = ignorefile.ReadAll(strings.NewReader(in.Pattern))
			if err == nil {
				var matcher *patternmatcher.PatternMatcher
				// Force compilation of excluded rules too, as the auditor diagnoses all bad rules.
				for _, p := range patterns {
					inputs := []string{p}
					if strings.HasPrefix(p, "!") {
						inputs = []string{"**", p}
					}
					var single *patternmatcher.PatternMatcher
					single, err = patternmatcher.New(inputs)
					if err == nil {
						_, err = single.MatchesOrParentMatches(".")
					}
					if err != nil {
						break
					}
				}
				if err == nil {
					matcher, err = patternmatcher.New(patterns)
				}
				if err == nil && filepath.Clean(in.Path) != "." {
					matched, err = matcher.MatchesOrParentMatches(filepath.ToSlash(filepath.Clean(in.Path)))
				}
			}
		}
		if err != nil {
			outputs[i] = -1
		} else if matched {
			outputs[i] = 1
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(outputs); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
}
