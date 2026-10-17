package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"golang.org/x/term"

	"diary/server/internal/adapters/auth"
)

// hashPassword implements `diary hash-password`: it reads a password and
// prints the argon2id hash for DIARY_PASSWORD_HASH.
func hashPassword() int {
	pw, err := readPassword("Password: ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if term.IsTerminal(int(os.Stdin.Fd())) {
		again, err := readPassword("Again: ")
		if err != nil || again != pw {
			fmt.Fprintln(os.Stderr, "The passwords don't match.")
			return 1
		}
	}
	if len(pw) < 8 {
		fmt.Fprintln(os.Stderr, "Use at least 8 characters.")
		return 1
	}
	hash, err := auth.HashPassword(pw)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println(hash)
	return 0
}

func readPassword(prompt string) (string, error) {
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		fmt.Fprint(os.Stderr, prompt)
		b, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		return string(b), err
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && line == "" {
		return "", fmt.Errorf("read password: %w", err)
	}
	// Windows PowerShell prefixes piped text with a UTF-8 byte-order mark.
	return strings.TrimRight(strings.TrimPrefix(line, string(rune(0xFEFF))), "\r\n"), nil
}
