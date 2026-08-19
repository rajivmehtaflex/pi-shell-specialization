# Shell-Scripting Capability Probe — 60 Questions

> Ask each question in a fresh model context. Require exactly one `bash` fenced code block and no explanation.

## Bash syntax and script structure

### 1. `bash-001` — easy

Write a script that prints the numbers 1 through 5, one per line, using a Bash loop, and saves that exact output to $TEST_ROOT/output.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 2. `bash-002` — easy

Write a script that accepts two positional arguments and writes their integer sum to $TEST_ROOT/sum.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 3. `bash-003` — easy

Write a script with a function named greet that writes `hello <name>` to $TEST_ROOT/greeting.txt for the name in $NAME.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 4. `bash-004` — easy

Write a script that uses a Bash case statement to map $COLOR=green to the word go in $TEST_ROOT/result.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 5. `bash-005` — medium

Write a script that reads lines from $TEST_ROOT/numbers.txt and writes their numeric total to $TEST_ROOT/total.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 6. `bash-006` — medium

Write a script that creates a small configuration file at $TEST_ROOT/config.ini using a quoted heredoc with the literal value $HOME.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Quoting, expansion, globbing, and arrays

### 7. `quote-001` — easy

Copy the file whose name is stored in $INPUT_FILE to $TEST_ROOT/copied.txt. The name contains spaces.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 8. `quote-002` — medium

List the literal filenames matching the pattern stored in $PATTERN without allowing the shell to expand the pattern before grep sees it.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 9. `quote-003` — easy

Write the value of $OPTION to $TEST_ROOT/option.txt. If it is unset or empty, write the word default.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 10. `quote-004` — hard

Define a Bash array FILES containing `one`, `two words`, and `three\nlines`; write each exact array element to $TEST_ROOT/list.txt without splitting elements.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 11. `quote-005` — hard

Use the value in $UNTRUSTED as data and write it to $TEST_ROOT/value.txt. The value contains `; touch $TEST_ROOT/injected` and must not execute.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 12. `quote-006` — medium

Define a Bash array containing `a` and `two words`; append the suffix .bak to each item and write the resulting names, one per line, to $TEST_ROOT/renamed.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Files, paths, permissions, and text processing

### 13. `file-001` — medium

Copy every .txt file from $TEST_ROOT/source into $TEST_ROOT/dest, preserving filenames with spaces and leaving unrelated files alone.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 14. `file-002` — easy

Create $TEST_ROOT/executable.sh with executable permissions and the content `printf ok`.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 15. `file-003` — medium

Find regular files below $TEST_ROOT/tree and write their relative paths, sorted, to $TEST_ROOT/files.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 16. `file-004` — medium

Convert the first CSV column from $TEST_ROOT/data.csv to uppercase and write the result to $TEST_ROOT/upper.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 17. `file-005` — hard

Create a temporary working file under $TEST_ROOT, use it to reverse the lines in $TEST_ROOT/input.txt, and leave no temporary file behind.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 18. `file-006` — hard

From any current directory, write the repository-relative path of $TEST_ROOT/input.txt to $TEST_ROOT/path.txt without hardcoding the absolute temp path.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Pipelines, streams, and command substitution

### 19. `pipe-001` — medium

Run a pipeline that reads $TEST_ROOT/input.txt and writes its uppercase contents to $TEST_ROOT/output.txt, while failing if any pipeline stage fails.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 20. `pipe-002` — medium

Write the same normalized input to both $TEST_ROOT/output.txt and $TEST_ROOT/audit.txt using one stream.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 21. `pipe-003` — hard

Read $TEST_ROOT/input.txt with a while-read loop and preserve the final line even when it has no trailing newline.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 22. `pipe-004` — hard

Capture the multi-line output of a command substitution into $TEST_ROOT/captured.txt without losing internal newlines.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 23. `pipe-005` — easy

Sort unique non-empty lines from $TEST_ROOT/input.txt and write them to $TEST_ROOT/unique.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 24. `pipe-006` — hard

Use a process substitution or an equivalent safe method to compare the sorted contents of $TEST_ROOT/left.txt and $TEST_ROOT/right.txt, writing equal or different to $TEST_ROOT/result.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Error handling, traps, cleanup, and idempotence

### 25. `error-001` — medium

Create $TEST_ROOT/temporary.txt, install a trap, and ensure it is removed when the script exits normally.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 26. `error-002` — medium

Use strict mode appropriately and write the default value `missing` when $OPTION is unset.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 27. `error-003` — hard

Retry a command up to three times using the counter in $TEST_ROOT/attempts, succeeding on the third attempt and writing success to $TEST_ROOT/result.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 28. `error-004` — medium

Create $TEST_ROOT/cache exactly once, write a one-time marker containing 1, and make the script safe to run twice.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 29. `error-005` — hard

Write a lock-protected result so two concurrent invocations do not corrupt $TEST_ROOT/result.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 30. `error-006` — hard

Run a child operation that fails, clean up temporary state, and return a nonzero exit code without hiding the failure.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Security and command-injection resistance

### 31. `safe-001` — easy

Use $NAME only as data in a greeting; the value may contain shell metacharacters and must be written literally.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 32. `safe-002` — hard

Delete only the file named by $TARGET inside $TEST_ROOT, rejecting absolute paths and path traversal.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 33. `safe-003` — hard

Read configuration data from $TEST_ROOT/untrusted.conf without sourcing or executing it, and copy its text to $TEST_ROOT/copied.conf.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 34. `safe-004` — medium

Create a temporary file safely inside $TEST_ROOT with a unique name, write `ok` to it, and record its path in $TEST_ROOT/temp_path; do not use a predictable global /tmp filename.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 35. `safe-005` — hard

Run only a command selected from the allowlist `date`, `printf`, or `true` in $COMMAND; reject every other value.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 36. `safe-006` — medium

Validate that $PORT is an integer between 1 and 65535 without invoking a shell or network client, writing valid or invalid to $TEST_ROOT/result.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Debugging and repairing broken scripts

### 37. `debug-001` — medium

Repair this script so a filename containing spaces is copied correctly: `for f in $(find . -type f); do cp $f out/; done`. Use the fixture files and produce the copied files.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 38. `debug-002` — medium

Repair a pipeline so failure is detected: `grep needle missing.txt | wc -l` must cause a nonzero script status and write no success marker.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 39. `debug-003` — easy

Repair an unset-variable bug in `echo "$OPTION"` by providing a safe default and writing it to $TEST_ROOT/result.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 40. `debug-004` — hard

Repair a partial-output bug: write the transformed result to a temporary file first and replace $TEST_ROOT/result.txt only if the transform succeeds.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 41. `debug-005` — medium

Diagnose a missing-command failure and write a clear error to stderr while returning nonzero; do not create $TEST_ROOT/success.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 42. `debug-006` — hard

Repair a script that overwrites an existing file: create a backup before replacing $TEST_ROOT/config.txt and preserve the original content in $TEST_ROOT/config.txt.bak.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Multi-step Pi terminal workflows

### 43. `agent-001` — medium

Inspect the files available in $TEST_ROOT, then write a script that converts the discovered .data file to .out without hardcoding its filename.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 44. `agent-002` — medium

Use the available terminal context to inspect manifest.txt and generate a script that writes its declared name and version to metadata.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 45. `agent-003` — hard

Create a script that checks all files under $TEST_ROOT/input before processing them, refuses to proceed if any file is empty, and writes the processed result to $TEST_ROOT/processed.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 46. `agent-004` — medium

Generate a repeatable backup workflow: inspect source.txt, create source.txt.bak, and verify the backup matches before reporting success.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 47. `agent-005` — hard

Use terminal inspection to discover whether jq is available; generate a script that parses input.json with jq when available and otherwise exits with a clear diagnostic.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 48. `agent-006` — medium

Work through a multi-step release check: inspect version.txt, validate that it matches v<major>.<minor>, and write release-ready or rejected to result.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Bash syntax and script structure

### 49. `bash-007` — medium

Read numbers.txt and write the largest integer to max.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 50. `bash-008` — hard

Use a quoted heredoc to write the literal two lines `home=$HOME` and `dollar=$5` to config.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Quoting, expansion, globbing, and arrays

### 51. `quote-007` — easy

Print the value of PATH as one line without word splitting or glob expansion.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 52. `quote-008` — medium

Create an array containing `alpha`, `two words`, and `three words`, then write exactly three lines to items.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Files, paths, permissions, and text processing

### 53. `file-007` — hard

Find all .log files under logs and write their relative paths sorted to logs.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 54. `file-008` — medium

Replace every COLOR token with COLOUR in notes.txt in place using macOS BSD sed semantics.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Pipelines, streams, and command substitution

### 55. `pipe-007` — medium

Prefix each line of input.txt with its 1-based line number as `<n>:<line>` and write numbered.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

### 56. `pipe-008` — easy

Write sorted unique non-empty lines from input.txt to unique.txt.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Error handling, traps, cleanup, and idempotence

### 57. `error-007` — medium

Require exactly one argument; with zero arguments print a usage message to stderr and exit 2.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Security and command-injection resistance

### 58. `safe-007` — medium

Copy untrusted.txt to copied.txt as data; never source or execute its contents.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Debugging and repairing broken scripts

### 59. `debug-007` — medium

Repair an unquoted filename expansion so `my file.txt` is copied to copied.txt without word splitting.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.

## Multi-step Pi terminal workflows

### 60. `agent-007` — medium

Inspect input files and sum all .entry integer files into total.txt without hardcoding their names.

Target environment: Linux Bash 5.x with GNU userland. Return exactly one Bash script in a single `bash` fenced code block. Use $TEST_ROOT for all files and do not use the network.
