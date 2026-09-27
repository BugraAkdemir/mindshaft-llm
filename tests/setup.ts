// Runs before every test file. The agent's modules create loggers lazily from
// the environment, so silencing here keeps test output to assertions only.
process.env['LOG_LEVEL'] = 'silent';
process.env['LOG_PRETTY'] = 'false';
