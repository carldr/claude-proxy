import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import { YamlConfigFile } from '../src/yaml_config_file.ts';

type ExampleConfig = { value: string };

const emptyExampleConfig: ExampleConfig = { value: 'empty' };

function parseExampleConfig(yamlValue: unknown): ExampleConfig {
  const value = (yamlValue as { value?: unknown } | null)?.value;
  if (typeof value !== 'string') throw new Error('value must be a string');
  return { value };
}

let configDirectory: string;
let configFilePath: string;
let writeCount: number;

/** Writes the file and gives it a modification time that differs from every earlier write. */
function writeConfigFile(fileText: string) {
  fs.writeFileSync(configFilePath, fileText);
  writeCount++;
  fs.utimesSync(configFilePath, new Date(1_700_000_000_000 + writeCount * 10_000), new Date(1_700_000_000_000 + writeCount * 10_000));
}

beforeEach(() => {
  configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml_config_file_test_'));
  configFilePath = path.join(configDirectory, 'example.yml');
  writeCount = 0;
});

afterEach(() => {
  fs.rmSync(configDirectory, { recursive: true, force: true });
});

test('keeps the last valid config when the file gets an error', () => {
  const yamlConfigFile = new YamlConfigFile(configFilePath, parseExampleConfig, emptyExampleConfig);
  writeConfigFile('value: first\n');
  const firstRead = yamlConfigFile.read();
  assert.deepEqual(firstRead.config, { value: 'first' });
  assert.equal(firstRead.loadError, null);
  writeConfigFile('value: [unclosed\n');
  const secondRead = yamlConfigFile.read();
  assert.deepEqual(secondRead.config, { value: 'first' });
  assert.notEqual(secondRead.loadError, null);
});

test('uses the empty config when the file is broken from the start', () => {
  const yamlConfigFile = new YamlConfigFile(configFilePath, parseExampleConfig, emptyExampleConfig);
  writeConfigFile('value: [unclosed\n');
  const { config, loadError } = yamlConfigFile.read();
  assert.deepEqual(config, emptyExampleConfig);
  assert.notEqual(loadError, null);
});

test('clears the error when the file is valid again', () => {
  const yamlConfigFile = new YamlConfigFile(configFilePath, parseExampleConfig, emptyExampleConfig);
  writeConfigFile('value: first\n');
  yamlConfigFile.read();
  writeConfigFile('value: [unclosed\n');
  yamlConfigFile.read();
  writeConfigFile('value: second\n');
  const { config, loadError } = yamlConfigFile.read();
  assert.deepEqual(config, { value: 'second' });
  assert.equal(loadError, null);
});
