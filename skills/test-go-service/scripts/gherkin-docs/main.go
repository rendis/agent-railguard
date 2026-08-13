// Command gherkin-docs verifies searchable GoDoc for Go/Godog step bindings.
package main

import (
	"errors"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// analyzerConfig defines portable syntax markers without coupling the analyzer to one service.
type analyzerConfig struct {
	contextType    string
	handlerMarker  string
	behaviorMarker string
}

// binding describes one Godog expression and its qualified named handler.
type binding struct {
	expression string
	handler    string
	position   token.Position
}

// packageDocs contains the documentation surface discovered in one Go package.
type packageDocs struct {
	identity    string
	packageDoc  string
	handlerDocs map[string]string
	bindings    []binding
}

// main delegates CLI execution and exits with the observed analyzer status.
func main() {
	os.Exit(run(os.Args[1:], os.Stderr))
}

// run validates CLI options and every step package below the explicit project-derived root.
//
// Flow:
//  1. Parse portable analyzer options without assuming a repository layout.
//  2. Require the caller to supply the steps root owned by its harness.
//  3. Verify the configured documentation contract and return an observable status.
func run(args []string, stderr io.Writer) int {
	// 1. Parse portable analyzer options without assuming a repository layout.
	flags := flag.NewFlagSet("gherkin-docs", flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("root", "", "root directory containing capability step packages (required)")
	contextType := flags.String("context-type", "godog.ScenarioContext", "qualified type that owns Step registrations")
	handlerMarker := flags.String("handler-marker", "implements the Gherkin step", "text identifying a handler GoDoc as step documentation")
	behaviorMarker := flags.String("behavior-marker", "Behavior:", "text identifying the handler behavior description")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		_, _ = fmt.Fprintf(stderr, "unexpected arguments: %s\n", strings.Join(flags.Args(), " "))
		return 2
	}

	// 2. Require the caller to supply the steps root owned by its harness.
	if strings.TrimSpace(*root) == "" {
		_, _ = fmt.Fprintln(stderr, "-root is required")
		return 2
	}

	config := analyzerConfig{
		contextType:    *contextType,
		handlerMarker:  *handlerMarker,
		behaviorMarker: *behaviorMarker,
	}

	// 3. Verify the configured documentation contract and return an observable status.
	if err := verifyRoot(*root, config); err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

// verifyRoot discovers step packages and returns every documentation violation as one error.
//
// Flow:
//  1. Discover Go packages below the configured steps root.
//  2. Parse package and handler GoDoc together with registered Godog bindings.
//  3. Verify bindings, handler docs and package indexes bidirectionally.
func verifyRoot(root string, config analyzerConfig) error {
	// 1. Discover Go packages below the configured steps root.
	directories, err := goPackageDirectories(root)
	if err != nil {
		return err
	}
	if len(directories) == 0 {
		return fmt.Errorf("no Go step packages found below %s", root)
	}

	var violations []string
	for _, directory := range directories {
		// 2. Parse package and handler GoDoc together with registered Godog bindings.
		packages, err := inspectDirectory(directory, config)
		if err != nil {
			violations = append(violations, err.Error())
			continue
		}

		// 3. Verify bindings, handler docs and package indexes bidirectionally.
		for _, documentation := range packages {
			violations = append(violations, documentation.verify(config)...)
		}
	}

	if len(violations) == 0 {
		return nil
	}
	sort.Strings(violations)
	return errors.New(strings.Join(violations, "\n"))
}

// goPackageDirectories returns directories containing Go source, including test-owned steps.
func goPackageDirectories(root string) ([]string, error) {
	seen := make(map[string]struct{})
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" {
			return nil
		}
		seen[filepath.Dir(path)] = struct{}{}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("walk step packages below %s: %w", root, err)
	}

	directories := make([]string, 0, len(seen))
	for directory := range seen {
		directories = append(directories, directory)
	}
	sort.Strings(directories)
	return directories, nil
}

// inspectDirectory parses every package variant found in one directory.
func inspectDirectory(directory string, config analyzerConfig) ([]packageDocs, error) {
	fileSet := token.NewFileSet()
	packages, err := parser.ParseDir(fileSet, directory, nil, parser.ParseComments)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", directory, err)
	}

	names := make([]string, 0, len(packages))
	for name := range packages {
		names = append(names, name)
	}
	sort.Strings(names)

	result := make([]packageDocs, 0, len(names))
	for _, name := range names {
		documentation := packageDocs{
			identity:    filepath.Join(directory, name),
			handlerDocs: make(map[string]string),
		}
		for _, file := range packages[name].Files {
			if file.Doc != nil {
				documentation.packageDoc += file.Doc.Text()
			}
			for _, declaration := range file.Decls {
				function, ok := declaration.(*ast.FuncDecl)
				if !ok {
					continue
				}
				handlerKey := declarationKey(function)
				if function.Doc != nil {
					documentation.handlerDocs[handlerKey] = function.Doc.Text()
				}
				documentation.bindings = append(documentation.bindings, functionBindings(fileSet, function, config)...)
			}
		}
		result = append(result, documentation)
	}
	return result, nil
}

// declarationKey qualifies methods by receiver so equally named handlers cannot collide.
func declarationKey(function *ast.FuncDecl) string {
	if function.Recv == nil || len(function.Recv.List) == 0 {
		return function.Name.Name
	}
	return typeName(function.Recv.List[0].Type) + "." + function.Name.Name
}

// functionBindings extracts Godog registrations made inside one function.
func functionBindings(fileSet *token.FileSet, function *ast.FuncDecl, config analyzerConfig) []binding {
	identifiers := make(map[string]string)
	indexFields(function.Recv, identifiers)
	indexFields(function.Type.Params, identifiers)
	indexFields(function.Type.Results, identifiers)

	var bindings []binding
	ast.Inspect(function.Body, func(node ast.Node) bool {
		current, ok := parseBinding(fileSet, node, identifiers, config)
		if ok {
			bindings = append(bindings, current)
		}
		return true
	})
	return bindings
}

// indexFields records parameter and receiver identifiers by qualified type.
func indexFields(fields *ast.FieldList, identifiers map[string]string) {
	if fields == nil {
		return
	}
	for _, field := range fields.List {
		currentType := typeName(field.Type)
		for _, name := range field.Names {
			identifiers[name.Name] = currentType
		}
	}
}

// typeName renders the named portion of pointers and qualified Go types.
func typeName(expression ast.Expr) string {
	switch current := expression.(type) {
	case *ast.Ident:
		return current.Name
	case *ast.StarExpr:
		return typeName(current.X)
	case *ast.SelectorExpr:
		return typeName(current.X) + "." + current.Sel.Name
	default:
		return ""
	}
}

// parseBinding extracts a literal Step registration owned by the configured Godog context type.
func parseBinding(fileSet *token.FileSet, node ast.Node, identifiers map[string]string, config analyzerConfig) (binding, bool) {
	call, ok := node.(*ast.CallExpr)
	if !ok || len(call.Args) != 2 {
		return binding{}, false
	}
	selector, ok := call.Fun.(*ast.SelectorExpr)
	context, contextOK := selectorExpressionName(selector)
	if !ok || !contextOK || selector.Sel.Name != "Step" || identifiers[context] != config.contextType {
		return binding{}, false
	}

	invalid := binding{position: fileSet.Position(call.Pos())}
	expressionLiteral, expressionOK := call.Args[0].(*ast.BasicLit)
	if !expressionOK || expressionLiteral.Kind != token.STRING {
		return invalid, true
	}
	expression, err := strconv.Unquote(expressionLiteral.Value)
	if err != nil {
		return invalid, true
	}

	handlerKey, handlerOK := handlerReference(call.Args[1], identifiers)
	if !handlerOK {
		return invalid, true
	}
	return binding{
		expression: normalizeExpression(expression),
		handler:    handlerKey,
		position:   fileSet.Position(call.Pos()),
	}, true
}

// selectorExpressionName returns the identifier at the left side of a method call.
func selectorExpressionName(selector *ast.SelectorExpr) (string, bool) {
	if selector == nil {
		return "", false
	}
	identifier, ok := selector.X.(*ast.Ident)
	return identifierName(identifier, ok)
}

// identifierName safely returns an AST identifier name.
func identifierName(identifier *ast.Ident, ok bool) (string, bool) {
	if !ok || identifier == nil {
		return "", false
	}
	return identifier.Name, true
}

// handlerReference qualifies a named function or receiver method used as a handler.
func handlerReference(expression ast.Expr, identifiers map[string]string) (string, bool) {
	switch current := expression.(type) {
	case *ast.Ident:
		return current.Name, true
	case *ast.SelectorExpr:
		receiver, ok := current.X.(*ast.Ident)
		if !ok || identifiers[receiver.Name] == "" {
			return "", false
		}
		return identifiers[receiver.Name] + "." + current.Sel.Name, true
	default:
		return "", false
	}
}

// normalizeExpression removes regex anchors for comparison with prose documentation.
func normalizeExpression(expression string) string {
	return strings.TrimSuffix(strings.TrimPrefix(expression, "^"), "$")
}

// normalizeIndexEntry removes common Gherkin keywords from a package index entry.
func normalizeIndexEntry(entry string) string {
	entry = strings.TrimSpace(entry)
	for _, keyword := range []string{"Given ", "When ", "Then ", "And ", "But ", "Dado ", "Cuando ", "Entonces ", "Y ", "Pero "} {
		if strings.HasPrefix(entry, keyword) {
			return strings.TrimSpace(strings.TrimPrefix(entry, keyword))
		}
	}
	return entry
}

// indexEntries extracts normalized bullet entries from the package Step index.
func indexEntries(packageDoc string) []string {
	var entries []string
	inIndex := false
	for _, line := range strings.Split(packageDoc, "\n") {
		line = strings.TrimSpace(line)
		if line == "Step index:" {
			inIndex = true
			continue
		}
		if !inIndex || line == "" {
			continue
		}
		if !strings.HasPrefix(line, "-") {
			break
		}
		entries = append(entries, normalizeIndexEntry(strings.TrimSpace(strings.TrimPrefix(line, "-"))))
	}
	return entries
}

// documentedExpression extracts the phrase owned by the handler marker instead of matching unrelated prose.
func documentedExpression(documentation string, config analyzerConfig) (string, bool) {
	markerIndex := strings.Index(documentation, config.handlerMarker)
	if markerIndex < 0 {
		return "", false
	}
	remainder := strings.TrimLeft(documentation[markerIndex+len(config.handlerMarker):], ": \t\r\n")
	if strings.HasPrefix(remainder, `"`) {
		closingQuote := strings.Index(remainder[1:], `"`)
		if closingQuote < 0 {
			return "", false
		}
		return normalizeIndexEntry(remainder[1 : closingQuote+1]), true
	}
	for _, line := range strings.Split(remainder, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, config.behaviorMarker) {
			return "", false
		}
		return normalizeIndexEntry(strings.Trim(strings.TrimSuffix(line, "."), `"`)), true
	}
	return "", false
}

// verify reports missing, stale or ambiguous documentation in both directions.
func (d packageDocs) verify(config analyzerConfig) []string {
	var violations []string
	bindingExpressions := make(map[string]int)
	boundHandlers := make(map[string]int)

	for _, current := range d.bindings {
		location := current.position.String()
		if current.expression == "" || current.handler == "" {
			violations = append(violations, location+": registered step must use a string literal and named handler")
			continue
		}
		bindingExpressions[current.expression]++
		boundHandlers[current.handler]++
		documentation := d.handlerDocs[current.handler]
		documented, hasDocumentedExpression := documentedExpression(documentation, config)
		if !strings.Contains(documentation, config.handlerMarker) ||
			!hasDocumentedExpression || documented != current.expression ||
			!strings.Contains(documentation, config.behaviorMarker) {
			violations = append(violations, fmt.Sprintf("%s: %s must have GoDoc declaring exact phrase %q after %q and include %q", location, current.handler, current.expression, config.handlerMarker, config.behaviorMarker))
		}
	}

	for expression, count := range bindingExpressions {
		if count > 1 {
			violations = append(violations, fmt.Sprintf("%s: duplicate binding expression %q", d.identity, expression))
		}
	}
	for handler, count := range boundHandlers {
		if count > 1 {
			violations = append(violations, fmt.Sprintf("%s: handler %s is registered %d times", d.identity, handler, count))
		}
	}
	for handler, documentation := range d.handlerDocs {
		if strings.Contains(documentation, config.handlerMarker) && boundHandlers[handler] == 0 {
			violations = append(violations, fmt.Sprintf("%s: documented handler %s has no Step binding", d.identity, handler))
		}
	}

	indexed := make(map[string]int)
	for _, entry := range indexEntries(d.packageDoc) {
		indexed[entry]++
	}
	for expression := range bindingExpressions {
		if indexed[expression] == 0 {
			violations = append(violations, fmt.Sprintf("%s: package Step index must contain %q", d.identity, expression))
		}
	}
	for entry, count := range indexed {
		if count > 1 {
			violations = append(violations, fmt.Sprintf("%s: package Step index duplicates %q", d.identity, entry))
		}
		if bindingExpressions[entry] == 0 {
			violations = append(violations, fmt.Sprintf("%s: package Step index contains stale entry %q", d.identity, entry))
		}
	}
	return violations
}
