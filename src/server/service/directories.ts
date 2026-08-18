import { opendir } from "node:fs/promises";
import path from "node:path";

import type { DirectoryListing } from "../../shared/protocol";
import { type HostPlatform, PlatformError } from "../platform";

const MAX_DIRECTORY_ENTRIES = 200;
const MAX_NAME_BYTES = 1_024;
const MAX_PATH_BYTES = 4_096;

interface AllowedRoot {
  displayPath: string;
  resolvedPath: string;
  name: string;
}

export class DirectoryService {
  readonly #platform: HostPlatform;
  readonly #configuredRoots: string[];
  #roots?: Promise<AllowedRoot[]>;

  constructor(
    platform: HostPlatform,
    configuredRoots: string[] = [],
  ) {
    this.#platform = platform;
    this.#configuredRoots = configuredRoots;
  }

  async list(requestedPath?: string): Promise<DirectoryListing> {
    const roots = await (this.#roots ??= this.#loadRoots());
    const input = requestedPath ?? roots[0]?.displayPath;
    if (!input || byteLength(input) > MAX_PATH_BYTES) {
      throw invalidDirectory();
    }

    const lexicalRoot = roots.find((root) => this.#contains(root.displayPath, input));
    if (!lexicalRoot) throw invalidDirectory();

    const current = await this.#platform.validateWorkingDirectory(input);
    const canonicalRoot = roots
      .filter((root) => this.#contains(root.resolvedPath, current.resolvedPath))
      .sort((left, right) => right.resolvedPath.length - left.resolvedPath.length)[0];
    if (!canonicalRoot) throw invalidDirectory();

    const directories: DirectoryListing["directories"] = [];
    let truncated = false;
    try {
      const handle = await opendir(current.displayPath);
      for await (const entry of handle) {
        if (!entry.isDirectory()) continue;
        const childPath = this.#path().join(current.displayPath, entry.name);
        if (byteLength(entry.name) > MAX_NAME_BYTES || byteLength(childPath) > MAX_PATH_BYTES) {
          continue;
        }
        if (directories.length === MAX_DIRECTORY_ENTRIES) {
          truncated = true;
          break;
        }
        directories.push({ name: entry.name, path: childPath });
      }
    } catch {
      throw invalidDirectory();
    }
    directories.sort((left, right) => left.name.localeCompare(right.name));

    const atRoot = this.#equal(canonicalRoot.resolvedPath, current.resolvedPath);
    return {
      current: {
        name: this.#path().basename(current.displayPath) || current.displayPath,
        path: current.displayPath,
      },
      ...(!atRoot ? { parent: this.#path().dirname(current.displayPath) } : {}),
      roots: roots.map((root) => ({ name: root.name, path: root.displayPath })),
      directories,
      truncated,
    };
  }

  async #loadRoots(): Promise<AllowedRoot[]> {
    const inputs = [this.#platform.homeDirectory(), ...this.#configuredRoots]
      .filter((value) => value.length > 0 && byteLength(value) <= MAX_PATH_BYTES);
    const roots: AllowedRoot[] = [];
    for (const [index, input] of inputs.entries()) {
      const validated = await this.#platform.validateWorkingDirectory(input);
      if (roots.some((root) => this.#equal(root.resolvedPath, validated.resolvedPath))) continue;
      roots.push({
        ...validated,
        name: index === 0
          ? "Home"
          : this.#path().basename(validated.displayPath) || validated.displayPath,
      });
    }
    if (roots.length === 0) throw invalidDirectory();
    return roots;
  }

  #contains(root: string, candidate: string): boolean {
    const relative = this.#path().relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !this.#path().isAbsolute(relative));
  }

  #equal(left: string, right: string): boolean {
    return this.#platform.kind === "windows"
      ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
      : left === right;
  }

  #path(): typeof path.posix | typeof path.win32 {
    return this.#platform.kind === "windows" ? path.win32 : path.posix;
  }
}

function invalidDirectory(): PlatformError {
  return new PlatformError(
    "invalidWorkingDirectory",
    "directory is outside the configured browse roots or is unavailable",
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
