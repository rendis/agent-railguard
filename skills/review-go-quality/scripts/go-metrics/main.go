package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
)

// Options controls the repository scope, output and optional metric limits.
type Options struct {
	// Root is the directory whose Go files are inspected.
	Root string
	// IncludeTests includes _test.go files in the report when true.
	IncludeTests bool
	// Format selects the text or JSON report representation.
	Format string
	// MaxLines is an optional mechanical function-length limit; zero keeps it report-only.
	MaxLines int
	// MaxParams is an optional mechanical parameter-count limit; zero keeps it report-only.
	MaxParams int
}

// Metric describes one observed Go function or method without assigning quality judgment.
type Metric struct {
	// File is the repository-relative source path.
	File string `json:"file"`
	// Name is the declared function or method name.
	Name string `json:"name"`
	// Kind distinguishes functions from methods.
	Kind string `json:"kind"`
	// Receiver is the formatted method receiver and is empty for functions.
	Receiver string `json:"receiver,omitempty"`
	// StartLine is the declaration's first source line.
	StartLine int `json:"start_line"`
	// EndLine is the declaration's final source line.
	EndLine int `json:"end_line"`
	// LineCount is the inclusive source length.
	LineCount int `json:"line_count"`
	// ParameterCount is the number of declared input parameters.
	ParameterCount int `json:"parameter_count"`
	// ResultCount is the number of declared results.
	ResultCount int `json:"result_count"`
	// CyclomaticComplexity is the basic branch-derived complexity candidate.
	CyclomaticComplexity int `json:"cyclomatic_complexity"`
}

// Violation reports one configured mechanical limit exceeded by a metric.
type Violation struct {
	// File is the source path containing the declaration.
	File string `json:"file"`
	// Name identifies the declaration that exceeded the limit.
	Name string `json:"name"`
	// Dimension identifies the configured metric limit.
	Dimension string `json:"dimension"`
	// Actual is the observed metric value.
	Actual int `json:"actual"`
	// Limit is the configured mechanical boundary.
	Limit int `json:"limit"`
}

// Report contains repository metrics and any configured mechanical violations.
type Report struct {
	// Root is the absolute directory inspected by the tool.
	Root string `json:"root"`
	// Metrics contains one entry per observed function or method.
	Metrics []Metric `json:"metrics"`
	// Violations contains only configured limits exceeded by Metrics.
	Violations []Violation `json:"violations"`
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run parses the CLI contract, gathers metrics and writes the requested report.
//
// Flow:
//  1. Parse and validate command-line options.
//  2. Resolve the root and discover eligible Go files.
//  3. Analyze and deterministically order function metrics.
//  4. Evaluate configured limits, render the report and return its status.
func run(args []string, stdout, stderr io.Writer) int {
	// 1. Parse and validate command-line options.
	flags := flag.NewFlagSet("go-metrics", flag.ContinueOnError)
	flags.SetOutput(stderr)

	options := Options{}
	flags.StringVar(&options.Root, "root", ".", "root directory to inspect")
	flags.BoolVar(&options.IncludeTests, "include-tests", false, "include _test.go files")
	flags.StringVar(&options.Format, "format", "text", "output format: text or json")
	flags.IntVar(&options.MaxLines, "max-lines", 0, "maximum function lines; zero reports only")
	flags.IntVar(&options.MaxParams, "max-params", 0, "maximum parameters; zero reports only")

	if err := flags.Parse(args); err != nil {
		return 1
	}
	if flags.NArg() != 0 {
		fmt.Fprintf(stderr, "unexpected arguments: %s\n", strings.Join(flags.Args(), " "))
		return 1
	}
	if options.Format != "text" && options.Format != "json" {
		fmt.Fprintf(stderr, "unsupported format %q: use text or json\n", options.Format)
		return 1
	}
	if options.MaxLines < 0 || options.MaxParams < 0 {
		fmt.Fprintln(stderr, "max-lines and max-params must be zero or positive")
		return 1
	}

	// 2. Resolve the root and discover eligible Go files.
	root, err := filepath.Abs(options.Root)
	if err != nil {
		fmt.Fprintf(stderr, "resolve root: %v\n", err)
		return 1
	}
	files, err := scanGoFiles(root, options.IncludeTests)
	if err != nil {
		fmt.Fprintf(stderr, "scan Go files: %v\n", err)
		return 1
	}

	// 3. Analyze and deterministically order function metrics.
	report := Report{
		Root:       root,
		Metrics:    make([]Metric, 0),
		Violations: make([]Violation, 0),
	}
	for _, path := range files {
		metrics, err := analyzeFile(root, path)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		report.Metrics = append(report.Metrics, metrics...)
	}
	sort.Slice(report.Metrics, func(i, j int) bool {
		left, right := report.Metrics[i], report.Metrics[j]
		if left.File != right.File {
			return left.File < right.File
		}
		if left.StartLine != right.StartLine {
			return left.StartLine < right.StartLine
		}
		return left.Name < right.Name
	})

	// 4. Evaluate configured limits, render the report and return its status.
	report.Violations = findViolations(report.Metrics, options)

	switch options.Format {
	case "json":
		err = writeJSON(stdout, report)
	default:
		err = writeText(stdout, report)
	}
	if err != nil {
		fmt.Fprintf(stderr, "write report: %v\n", err)
		return 1
	}
	if len(report.Violations) > 0 {
		return 2
	}
	return 0
}

// scanGoFiles returns deterministically ordered Go sources under an eligible directory tree.
//
// Flow:
//  1. Validate that root is a directory.
//  2. Walk eligible directories and collect the requested Go files.
//  3. Sort the paths for stable analysis.
func scanGoFiles(root string, includeTests bool) ([]string, error) {
	// 1. Validate that root is a directory.
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", root)
	}

	// 2. Walk eligible directories and collect the requested Go files.
	files := make([]string, 0)
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			switch entry.Name() {
			case ".git", "vendor", "testdata":
				if path != root {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if filepath.Ext(path) != ".go" {
			return nil
		}
		if !includeTests && strings.HasSuffix(path, "_test.go") {
			return nil
		}
		files = append(files, path)
		return nil
	})
	if err != nil {
		return nil, err
	}

	// 3. Sort the paths for stable analysis.
	sort.Strings(files)
	return files, nil
}

// analyzeFile extracts function and method metrics from one non-generated Go source.
//
// Flow:
//  1. Parse the source and ignore generated files.
//  2. Resolve its repository-relative identity.
//  3. Measure every function and method declaration.
func analyzeFile(root, path string) ([]Metric, error) {
	// 1. Parse the source and ignore generated files.
	fileSet := token.NewFileSet()
	file, err := parser.ParseFile(fileSet, path, nil, parser.ParseComments|parser.AllErrors)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if ast.IsGenerated(file) {
		return nil, nil
	}

	// 2. Resolve its repository-relative identity.
	relative, err := filepath.Rel(root, path)
	if err != nil {
		return nil, fmt.Errorf("make path relative: %w", err)
	}

	// 3. Measure every function and method declaration.
	metrics := make([]Metric, 0)
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok {
			continue
		}

		start := fileSet.Position(function.Pos()).Line
		end := fileSet.Position(function.End()).Line
		receiver, err := receiverName(fileSet, function.Recv)
		if err != nil {
			return nil, fmt.Errorf("format receiver for %s: %w", function.Name.Name, err)
		}
		kind := "function"
		if receiver != "" {
			kind = "method"
		}
		metrics = append(metrics, Metric{
			File:                 filepath.ToSlash(relative),
			Name:                 function.Name.Name,
			Kind:                 kind,
			Receiver:             receiver,
			StartLine:            start,
			EndLine:              end,
			LineCount:            end - start + 1,
			ParameterCount:       countFieldList(function.Type.Params),
			ResultCount:          countFieldList(function.Type.Results),
			CyclomaticComplexity: cyclomaticComplexity(function.Body),
		})
	}
	return metrics, nil
}

func receiverName(fileSet *token.FileSet, receivers *ast.FieldList) (string, error) {
	if receivers == nil || len(receivers.List) == 0 {
		return "", nil
	}
	var output bytes.Buffer
	if err := format.Node(&output, fileSet, receivers.List[0].Type); err != nil {
		return "", err
	}
	return output.String(), nil
}

func countFieldList(fields *ast.FieldList) int {
	if fields == nil {
		return 0
	}
	count := 0
	for _, field := range fields.List {
		if len(field.Names) == 0 {
			count++
			continue
		}
		count += len(field.Names)
	}
	return count
}

func cyclomaticComplexity(body *ast.BlockStmt) int {
	if body == nil {
		return 1
	}
	complexity := 1
	ast.Inspect(body, func(node ast.Node) bool {
		switch current := node.(type) {
		case *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt:
			complexity++
		case *ast.CaseClause:
			if len(current.List) > 0 {
				complexity++
			}
		case *ast.CommClause:
			if current.Comm != nil {
				complexity++
			}
		case *ast.BinaryExpr:
			if current.Op == token.LAND || current.Op == token.LOR {
				complexity++
			}
		}
		return true
	})
	return complexity
}

func findViolations(metrics []Metric, options Options) []Violation {
	violations := make([]Violation, 0)
	for _, metric := range metrics {
		if options.MaxLines > 0 && metric.LineCount > options.MaxLines {
			violations = append(violations, Violation{
				File:      metric.File,
				Name:      metric.Name,
				Dimension: "line_count",
				Actual:    metric.LineCount,
				Limit:     options.MaxLines,
			})
		}
		if options.MaxParams > 0 && metric.ParameterCount > options.MaxParams {
			violations = append(violations, Violation{
				File:      metric.File,
				Name:      metric.Name,
				Dimension: "parameter_count",
				Actual:    metric.ParameterCount,
				Limit:     options.MaxParams,
			})
		}
	}
	return violations
}

func writeJSON(output io.Writer, report Report) error {
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	return encoder.Encode(report)
}

func writeText(output io.Writer, report Report) error {
	writer := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(writer, "FILE\tNAME\tKIND\tRECEIVER\tLINES\tPARAMS\tRESULTS\tCOMPLEXITY"); err != nil {
		return err
	}
	for _, metric := range report.Metrics {
		if _, err := fmt.Fprintf(
			writer,
			"%s\t%s\t%s\t%s\t%d\t%d\t%d\t%d\n",
			metric.File,
			metric.Name,
			metric.Kind,
			metric.Receiver,
			metric.LineCount,
			metric.ParameterCount,
			metric.ResultCount,
			metric.CyclomaticComplexity,
		); err != nil {
			return err
		}
	}
	for _, violation := range report.Violations {
		if _, err := fmt.Fprintf(
			writer,
			"VIOLATION\t%s:%s\t%s\t\t%d>%d\t\t\t\n",
			violation.File,
			violation.Name,
			violation.Dimension,
			violation.Actual,
			violation.Limit,
		); err != nil {
			return err
		}
	}
	return writer.Flush()
}
