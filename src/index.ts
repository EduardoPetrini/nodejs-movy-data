import { loadEnvFile } from './shared/utils';
import { runCli } from './presentation/cli/cli';

loadEnvFile();
runCli();
