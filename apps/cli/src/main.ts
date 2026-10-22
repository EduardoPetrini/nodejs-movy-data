import { loadEnvFile } from '@movy/core';
import { runCli } from './presentation/cli/cli';

loadEnvFile();
runCli();
