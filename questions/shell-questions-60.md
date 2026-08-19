# Shell-Scripting Capability Probe — 60 Questions

> Prepared for external evaluation of `qwen3.5:9b`. No Ollama evaluation was run on this machine.

## Administration protocol

Ask each question independently in a fresh conversation or reset context. Require the model to return exactly one `bash` fenced code block and no explanation. Record the raw response, model version, decoding settings, and question ID. Execute and score the returned script only in a separate disposable sandbox; this file is a question set, not an instruction to execute scripts locally.

Each item includes fixture setup and hidden verification intent so an external evaluator can reproduce the test. Do not reveal the verification details to the model.

## Bash syntax and script structure

### 1. `bash-001` — easy

**Question to ask the model:**

Write a script that prints the numbers 1 through 5, one per line, using a Bash loop, and saves that exact output to $TEST_ROOT/output.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** script parses and uses a loop

### 2. `bash-002` — easy

**Question to ask the model:**

Write a script that accepts two positional arguments and writes their integer sum to $TEST_ROOT/sum.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": ["2", "5"], "environment": {}, "setup": "true"}
```

**Verification intent:** positional arguments are handled

### 3. `bash-003` — easy

**Question to ask the model:**

Write a script with a function named greet that writes `hello <name>` to $TEST_ROOT/greeting.txt for the name in $NAME.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {"NAME": "Ada"}, "setup": "true"}
```

**Verification intent:** functions and environment variables work

### 4. `bash-004` — easy

**Question to ask the model:**

Write a script that uses a Bash case statement to map $COLOR=green to the word go in $TEST_ROOT/result.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {"COLOR": "green"}, "setup": "true"}
```

**Verification intent:** case branches select the correct result

### 5. `bash-005` — medium

**Question to ask the model:**

Write a script that reads lines from $TEST_ROOT/numbers.txt and writes their numeric total to $TEST_ROOT/total.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf '2\\n3\\n5\\n' > numbers.txt"}
```

**Verification intent:** input is read line by line

### 6. `bash-006` — medium

**Question to ask the model:**

Write a script that creates a small configuration file at $TEST_ROOT/config.ini using a quoted heredoc with the literal value $HOME.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** heredoc quoting preserves literal content

## Quoting, expansion, globbing, and arrays

### 7. `quote-001` — easy

**Question to ask the model:**

Copy the file whose name is stored in $INPUT_FILE to $TEST_ROOT/copied.txt. The name contains spaces.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {"INPUT_FILE": "input file.txt"}, "setup": "printf 'payload' > 'input file.txt'"}
```

**Verification intent:** spaces in paths are preserved

### 8. `quote-002` — medium

**Question to ask the model:**

List the literal filenames matching the pattern stored in $PATTERN without allowing the shell to expand the pattern before grep sees it.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {"PATTERN": "a*"}, "setup": "printf 'a*\\na1\\n' > names.txt"}
```

**Verification intent:** literal glob characters remain literal

### 9. `quote-003` — easy

**Question to ask the model:**

Write the value of $OPTION to $TEST_ROOT/option.txt. If it is unset or empty, write the word default.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "unset OPTION"}
```

**Verification intent:** empty values use the default

### 10. `quote-004` — hard

**Question to ask the model:**

Define a Bash array FILES containing `one`, `two words`, and `three\nlines`; write each exact array element to $TEST_ROOT/list.txt without splitting elements.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** array elements are not split

### 11. `quote-005` — hard

**Question to ask the model:**

Use the value in $UNTRUSTED as data and write it to $TEST_ROOT/value.txt. The value contains `; touch $TEST_ROOT/injected` and must not execute.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {"UNTRUSTED": "safe; touch injected"}, "setup": "true"}
```

**Verification intent:** untrusted data is never executed

### 12. `quote-006` — medium

**Question to ask the model:**

Define a Bash array containing `a` and `two words`; append the suffix .bak to each item and write the resulting names, one per line, to $TEST_ROOT/renamed.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** array transformation preserves boundaries

## Files, paths, permissions, and text processing

### 13. `file-001` — medium

**Question to ask the model:**

Copy every .txt file from $TEST_ROOT/source into $TEST_ROOT/dest, preserving filenames with spaces and leaving unrelated files alone.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "mkdir source dest; printf a > 'source/one.txt'; printf b > 'source/two words.txt'; printf c > source/skip.log"}
```

**Verification intent:** files are selected by extension

### 14. `file-002` — easy

**Question to ask the model:**

Create $TEST_ROOT/executable.sh with executable permissions and the content `printf ok`.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** permissions are set deliberately

### 15. `file-003` — medium

**Question to ask the model:**

Find regular files below $TEST_ROOT/tree and write their relative paths, sorted, to $TEST_ROOT/files.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "mkdir -p tree/a tree/b; touch tree/a/one tree/b/two"}
```

**Verification intent:** find output is relative and sorted

### 16. `file-004` — medium

**Question to ask the model:**

Convert the first CSV column from $TEST_ROOT/data.csv to uppercase and write the result to $TEST_ROOT/upper.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'alice,1\\nbob,2\\n' > data.csv"}
```

**Verification intent:** CSV rows are processed deterministically

### 17. `file-005` — hard

**Question to ask the model:**

Create a temporary working file under $TEST_ROOT, use it to reverse the lines in $TEST_ROOT/input.txt, and leave no temporary file behind.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'one\\ntwo\\n' > input.txt"}
```

**Verification intent:** temporary state is cleaned up

### 18. `file-006` — hard

**Question to ask the model:**

From any current directory, write the repository-relative path of $TEST_ROOT/input.txt to $TEST_ROOT/path.txt without hardcoding the absolute temp path.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "touch input.txt"}
```

**Verification intent:** path handling is independent of the launch directory

## Pipelines, streams, and command substitution

### 19. `pipe-001` — medium

**Question to ask the model:**

Run a pipeline that reads $TEST_ROOT/input.txt and writes its uppercase contents to $TEST_ROOT/output.txt, while failing if any pipeline stage fails.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'hello\\n' > input.txt"}
```

**Verification intent:** pipeline output is correct and failures propagate

### 20. `pipe-002` — medium

**Question to ask the model:**

Write the same normalized input to both $TEST_ROOT/output.txt and $TEST_ROOT/audit.txt using one stream.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf ' hello \\n' > input.txt"}
```

**Verification intent:** tee-like fanout is consistent

### 21. `pipe-003` — hard

**Question to ask the model:**

Read $TEST_ROOT/input.txt with a while-read loop and preserve the final line even when it has no trailing newline.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'first\\nlast' > input.txt"}
```

**Verification intent:** while-read handles final unterminated line

### 22. `pipe-004` — hard

**Question to ask the model:**

Capture the multi-line output of a command substitution into $TEST_ROOT/captured.txt without losing internal newlines.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** command substitution output remains line-oriented

### 23. `pipe-005` — easy

**Question to ask the model:**

Sort unique non-empty lines from $TEST_ROOT/input.txt and write them to $TEST_ROOT/unique.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'b\\na\\nb\\n\\n' > input.txt"}
```

**Verification intent:** empty lines are removed and duplicates collapse

### 24. `pipe-006` — hard

**Question to ask the model:**

Use a process substitution or an equivalent safe method to compare the sorted contents of $TEST_ROOT/left.txt and $TEST_ROOT/right.txt, writing equal or different to $TEST_ROOT/result.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'b\\na\\n' > left.txt; printf 'a\\nb\\n' > right.txt"}
```

**Verification intent:** comparison is order-insensitive

## Error handling, traps, cleanup, and idempotence

### 25. `error-001` — medium

**Question to ask the model:**

Create $TEST_ROOT/temporary.txt, install a trap, and ensure it is removed when the script exits normally.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** cleanup happens on normal exit

### 26. `error-002` — medium

**Question to ask the model:**

Use strict mode appropriately and write the default value `missing` when $OPTION is unset.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "unset OPTION"}
```

**Verification intent:** unset variables do not silently corrupt output

### 27. `error-003` — hard

**Question to ask the model:**

Retry a command up to three times using the counter in $TEST_ROOT/attempts, succeeding on the third attempt and writing success to $TEST_ROOT/result.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 0 > attempts"}
```

**Verification intent:** retry count is bounded and succeeds

### 28. `error-004` — medium

**Question to ask the model:**

Create $TEST_ROOT/cache exactly once, write a one-time marker containing 1, and make the script safe to run twice.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** repeated execution is idempotent

### 29. `error-005` — hard

**Question to ask the model:**

Write a lock-protected result so two concurrent invocations do not corrupt $TEST_ROOT/result.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** concurrent writes are coordinated

### 30. `error-006` — hard

**Question to ask the model:**

Run a child operation that fails, clean up temporary state, and return a nonzero exit code without hiding the failure.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** failure status is preserved and cleanup runs

## Security and command-injection resistance

### 31. `safe-001` — easy

**Question to ask the model:**

Use $NAME only as data in a greeting; the value may contain shell metacharacters and must be written literally.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {"NAME": "Alice; touch compromised"}, "setup": "true"}
```

**Verification intent:** data cannot become code

### 32. `safe-002` — hard

**Question to ask the model:**

Delete only the file named by $TARGET inside $TEST_ROOT, rejecting absolute paths and path traversal.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf x > safe.txt; TARGET='../safe.txt'"}
```

**Verification intent:** path traversal is rejected

### 33. `safe-003` — hard

**Question to ask the model:**

Read configuration data from $TEST_ROOT/untrusted.conf without sourcing or executing it, and copy its text to $TEST_ROOT/copied.conf.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'touch compromised\\n' > untrusted.conf"}
```

**Verification intent:** untrusted configuration is treated as data

### 34. `safe-004` — medium

**Question to ask the model:**

Create a temporary file safely inside $TEST_ROOT with a unique name, write `ok` to it, and record its path in $TEST_ROOT/temp_path; do not use a predictable global /tmp filename.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** temporary file name is generated safely

### 35. `safe-005` — hard

**Question to ask the model:**

Run only a command selected from the allowlist `date`, `printf`, or `true` in $COMMAND; reject every other value.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {"COMMAND": "rm"}, "setup": "true"}
```

**Verification intent:** allowlisted commands are enforced

### 36. `safe-006` — medium

**Question to ask the model:**

Validate that $PORT is an integer between 1 and 65535 without invoking a shell or network client, writing valid or invalid to $TEST_ROOT/result.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {"PORT": "8080; touch compromised"}, "setup": "true"}
```

**Verification intent:** numeric validation rejects shell syntax

## Debugging and repairing broken scripts

### 37. `debug-001` — medium

**Question to ask the model:**

Repair this script so a filename containing spaces is copied correctly: `for f in $(find . -type f); do cp $f out/; done`. Use the fixture files and produce the copied files.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "mkdir out; touch 'one file.txt'"}
```

**Verification intent:** broken word splitting is repaired

### 38. `debug-002` — medium

**Question to ask the model:**

Repair a pipeline so failure is detected: `grep needle missing.txt | wc -l` must cause a nonzero script status and write no success marker.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** pipeline failure is not hidden

### 39. `debug-003` — easy

**Question to ask the model:**

Repair an unset-variable bug in `echo "$OPTION"` by providing a safe default and writing it to $TEST_ROOT/result.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "unset OPTION"}
```

**Verification intent:** unset input receives a defined default

### 40. `debug-004` — hard

**Question to ask the model:**

Repair a partial-output bug: write the transformed result to a temporary file first and replace $TEST_ROOT/result.txt only if the transform succeeds.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'ok\\n' > input.txt"}
```

**Verification intent:** failed transforms do not leave partial output

### 41. `debug-005` — medium

**Question to ask the model:**

Diagnose a missing-command failure and write a clear error to stderr while returning nonzero; do not create $TEST_ROOT/success.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** failure is visible and correctly reported

### 42. `debug-006` — hard

**Question to ask the model:**

Repair a script that overwrites an existing file: create a backup before replacing $TEST_ROOT/config.txt and preserve the original content in $TEST_ROOT/config.txt.bak.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf old > config.txt"}
```

**Verification intent:** existing state is preserved before replacement

## Multi-step Pi terminal workflows

### 43. `agent-001` — medium

**Question to ask the model:**

Inspect the files available in $TEST_ROOT, then write a script that converts the discovered .data file to .out without hardcoding its filename.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'payload' > discovered.data"}
```

**Verification intent:** the workflow discovers inputs before acting

### 44. `agent-002` — medium

**Question to ask the model:**

Use the available terminal context to inspect manifest.txt and generate a script that writes its declared name and version to metadata.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'name=demo\\nversion=1.2\\n' > manifest.txt"}
```

**Verification intent:** the workflow reads the manifest and verifies output

### 45. `agent-003` — hard

**Question to ask the model:**

Create a script that checks all files under $TEST_ROOT/input before processing them, refuses to proceed if any file is empty, and writes the processed result to $TEST_ROOT/processed.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "mkdir input; printf x > input/a; printf y > input/b"}
```

**Verification intent:** preconditions are checked before mutation

### 46. `agent-004` — medium

**Question to ask the model:**

Generate a repeatable backup workflow: inspect source.txt, create source.txt.bak, and verify the backup matches before reporting success.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf source > source.txt"}
```

**Verification intent:** backup and verification are both present

### 47. `agent-005` — hard

**Question to ask the model:**

Use terminal inspection to discover whether jq is available; generate a script that parses input.json with jq when available and otherwise exits with a clear diagnostic.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf '{\"name\":\"demo\"}\\n' > input.json"}
```

**Verification intent:** optional dependency handling is explicit

### 48. `agent-006` — medium

**Question to ask the model:**

Work through a multi-step release check: inspect version.txt, validate that it matches v<major>.<minor>, and write release-ready or rejected to result.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'v1.2\\n' > version.txt"}
```

**Verification intent:** the workflow inspects, validates, and reports

## Bash syntax and script structure

### 49. `bash-007` — medium

**Question to ask the model:**

Read numbers.txt and write the largest integer to max.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf '4\\n9\\n2\\n' > numbers.txt"}
```

**Verification intent:** loop and numeric comparison work

### 50. `bash-008` — hard

**Question to ask the model:**

Use a quoted heredoc to write the literal two lines `home=$HOME` and `dollar=$5` to config.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** heredoc preserves literal variables

## Quoting, expansion, globbing, and arrays

### 51. `quote-007` — easy

**Question to ask the model:**

Print the value of PATH as one line without word splitting or glob expansion.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** quoted expansion preserves data

### 52. `quote-008` — medium

**Question to ask the model:**

Create an array containing `alpha`, `two words`, and `three words`, then write exactly three lines to items.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** array boundaries are preserved

## Files, paths, permissions, and text processing

### 53. `file-007` — hard

**Question to ask the model:**

Find all .log files under logs and write their relative paths sorted to logs.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "mkdir -p logs/sub; touch logs/a.log 'logs/sub/b log.log' logs/no.txt"}
```

**Verification intent:** recursive file selection handles spaces

### 54. `file-008` — medium

**Question to ask the model:**

Replace every COLOR token with COLOUR in notes.txt in place using macOS BSD sed semantics.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'COLOR red\\nCOLOR blue\\n' > notes.txt"}
```

**Verification intent:** BSD in-place editing works

## Pipelines, streams, and command substitution

### 55. `pipe-007` — medium

**Question to ask the model:**

Prefix each line of input.txt with its 1-based line number as `<n>:<line>` and write numbered.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'one\\ntwo\\nthree\\n' > input.txt"}
```

**Verification intent:** stream processing preserves line order

### 56. `pipe-008` — easy

**Question to ask the model:**

Write sorted unique non-empty lines from input.txt to unique.txt.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'b\\na\\nb\\n\\n' > input.txt"}
```

**Verification intent:** sort and uniqueness are correct

## Error handling, traps, cleanup, and idempotence

### 57. `error-007` — medium

**Question to ask the model:**

Require exactly one argument; with zero arguments print a usage message to stderr and exit 2.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "true"}
```

**Verification intent:** argument validation is explicit

## Security and command-injection resistance

### 58. `safe-007` — medium

**Question to ask the model:**

Copy untrusted.txt to copied.txt as data; never source or execute its contents.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 'touch compromised\\n' > untrusted.txt"}
```

**Verification intent:** untrusted content stays data

## Debugging and repairing broken scripts

### 59. `debug-007` — medium

**Question to ask the model:**

Repair an unquoted filename expansion so `my file.txt` is copied to copied.txt without word splitting.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf payload > 'my file.txt'"}
```

**Verification intent:** quoting bug is repaired

## Multi-step Pi terminal workflows

### 60. `agent-007` — medium

**Question to ask the model:**

Inspect input files and sum all .entry integer files into total.txt without hardcoding their names.

**External fixture (do not include in the model prompt):**

```json
{"arguments": [], "environment": {}, "setup": "printf 2 > a.entry; printf 3 > b.entry"}
```

**Verification intent:** multi-file discovery and aggregation work
