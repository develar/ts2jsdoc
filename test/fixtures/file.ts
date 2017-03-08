import {VersionInfo} from "publish-api";

export function foo(options: Electron.RequestOptions, error: Error, info: VersionInfo, name: "foo" | "bar"): void {
}

export function bool() {
  return true
}

export function num() {
  return 1
}