package main

import "os"

func replaceRelease(source, target string) error { return os.Rename(source, target) }
