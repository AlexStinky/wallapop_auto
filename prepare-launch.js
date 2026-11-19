const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fingerprint(directory, inputs, extra = []) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([process.version, process.platform, process.arch, ...extra]));

  function addInput(input) {
    const file = path.join(directory, input);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) {
        addInput(path.join(input, name));
      }
    } else if (stat?.isFile()) {
      const contents = fs.readFileSync(file);
      hash.update(JSON.stringify([input, contents.length]));
      hash.update(contents);
    }
  }

  for (const input of inputs) {
    addInput(input);
  }
  return hash.digest('hex');
}

function npm(directory, args) {
  const options = { cwd: directory, stdio: 'inherit' };
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'npm.cmd', ...args], options);
  } else {
    execFileSync('npm', args, options);
  }
}

function prepare(directory, marker, expectedOutput, key, label, args) {
  const markerPath = path.join(directory, marker);
  if (fs.existsSync(markerPath) && fs.existsSync(path.join(directory, expectedOutput)) &&
      fs.readFileSync(markerPath, 'utf8') === key) {
    console.log(`${label} is up to date.`);
    return;
  }

  fs.rmSync(markerPath, { force: true });
  console.log(`Preparing ${label.toLowerCase()}...`);
  npm(directory, args);
  fs.writeFileSync(markerPath, key);
}

function installDependencies(directory, tool, label) {
  const key = fingerprint(directory, ['package.json', 'package-lock.json', '.npmrc']);
  const executable = process.platform === 'win32' ? `${tool}.cmd` : tool;
  prepare(directory, 'node_modules/.launcher-dependencies', `node_modules/.bin/${executable}`,
    key, label, ['ci', '--no-audit', '--no-fund']);
  return key;
}

function prepareBackend() {
  const directory = path.join(__dirname, 'backend');
  const dependencies = installDependencies(directory, 'tsc', 'Backend dependencies');
  const prisma = fingerprint(directory, ['prisma/schema.prisma'], [dependencies]);
  prepare(directory, 'node_modules/.prisma/client/.launcher-ready', 'node_modules/.prisma/client/index.js',
    prisma, 'Prisma client', ['run', 'db:generate']);

  const build = fingerprint(directory, ['src', 'tsconfig.json'], [prisma]);
  prepare(directory, '.launcher-dist/.launcher-ready', '.launcher-dist/index.js',
    build, 'Backend build', ['run', 'build', '--', '--outDir', '.launcher-dist']);
}

function prepareFrontend() {
  const directory = path.join(__dirname, 'frontend');
  const dependencies = installDependencies(directory, 'next', 'Frontend dependencies');
  const inputs = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name !== 'next-env.d.ts' &&
      (/^\.env(?:\.|$)/.test(entry.name) || /\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)))
    .map(entry => entry.name)
    .sort();
  const publicEnvironment = Object.entries(process.env)
    .filter(([name]) => name.startsWith('NEXT_PUBLIC_'))
    .sort(([first], [second]) => first.localeCompare(second));
  const build = fingerprint(directory, ['src', 'public', ...inputs], [dependencies, publicEnvironment]);
  prepare(directory, '.next/.launcher-ready', '.next/BUILD_ID', build, 'Frontend build', ['run', 'build']);
}

try {
  prepareBackend();
  prepareFrontend();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
