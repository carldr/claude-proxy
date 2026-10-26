import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';

/**
 * Reads a YAML file and parses it again only when its modification time changes.
 * After a parse or validation error, the file keeps the last config that loaded without an error.
 * Before any valid load, the config is the empty config.
 * The error is reported, so the caller can show it in the web UI.
 */
export class YamlConfigFile<ParsedConfig> {
  private loadedModificationTimeMs: number | null = null;
  private loadedConfig: ParsedConfig;
  private loadError: string | null = null;
  readonly filePath: string;
  private readonly parseConfig: (yamlValue: unknown) => ParsedConfig;
  private readonly emptyConfig: ParsedConfig;

  constructor(filePath: string, parseConfig: (yamlValue: unknown) => ParsedConfig, emptyConfig: ParsedConfig) {
    this.filePath = filePath;
    this.parseConfig = parseConfig;
    this.emptyConfig = emptyConfig;
    this.loadedConfig = emptyConfig;
  }

  read(): { config: ParsedConfig; loadError: string | null } {
    let modificationTimeMs: number;
    try {
      modificationTimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch {
      return { config: this.emptyConfig, loadError: `${this.filePath} does not exist` };
    }
    if (modificationTimeMs !== this.loadedModificationTimeMs) {
      this.loadedModificationTimeMs = modificationTimeMs;
      try {
        this.loadedConfig = this.parseConfig(parseYaml(fs.readFileSync(this.filePath, 'utf8')));
        this.loadError = null;
      } catch (error) {
        this.loadError = `${this.filePath}: ${(error as Error).message}`;
        console.error(this.loadError);
      }
    }
    return { config: this.loadedConfig, loadError: this.loadError };
  }
}
