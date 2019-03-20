const { spawn } = require('child_process')
var os = require('os')
var path = require('path')
var asyncpify = require('asyncpify')
const fs = require('fs')
fs.promises =  asyncpify(fs)
const getUser = asyncpify(require('etc-passwd').getUser);
const keyring = require('keyring-gpg')
const { getRandStr } = require('guld-random')
var readline = require('readline');
const log = require('node-file-logger')

var workers = {}

try {
  fs.mkdirSync(`/var/log/guld`, {mode: 0o777})
} catch (e) {
}

process.chdir(`/var/log/guld`)

const options = {
  folderPath: './',
  dateBasedFileNaming: true,
  fileNamePrefix: `super-server-`,
  fileNameSuffix: '',
  fileNameExtension: '.log',
  dateFormat: 'YYYY-MM-DD',
  timeFormat: 'HH:mm:ss.SSS',
  logLevel: 'debug',
  onlyFileLogging: false
}
log.SetUserOptions(options)

async function spawnGuldUserWorker (username) {
  var stats = await fs.promises.stat(`/tmp/${username}-server.sock`).catch(e => {})
  if (stats === undefined || !stats.isFile()) {
    var user = await getUser({username: username})
    if (user) {
      var guser = await getUser({username: 'www-data'})
      if (guser) {
        fs.mkdir(`/var/log/guld/@${username}`, {mode: 0o777}, e => {
          fs.chown(`/var/log/guld/@${username}`, user.uid, user.gid, e => {
            workers[username] = spawn('node', [path.join(__dirname, 'index.js')], {env: {USER: username, GULDUSER: username}, uid: user.uid, gid: guser.gid})
            workers[username].stdout.setEncoding('utf-8')
            workers[username].stdout.on('data', (data) => {
              process.stdout.write(data)
            })
            workers[username].stderr.setEncoding('utf-8')
            workers[username].stderr.on('data', (data) => {
              process.stderr.write(data)
            })
          })
        })
      }
    }
  }
}

async function spawnGuldUserWorkers () {
  var curline = ''
  var htpasswd = fs.createReadStream('/etc/htpasswd', {encoding: 'utf8'})
  htpasswd.on('data', async (chunk) => {
    if (chunk.indexOf('\n') > -1) {
      curline = curline + chunk.slice(0, chunk.indexOf('\n'))
      var curuser = curline.split(':')
      await spawnGuldUserWorker(curuser[0])
      curline = chunk.slice(chunk.indexOf('\n'))
    } else curline = curline + chunk
  });
  await spawnGuldUserWorker('guld')
}

process.on('SIGINT', cleanupExit)
process.on('SIGTERM', cleanupExit)
process.on('SIGHUP', cleanupExit)

function cleanup (exitCode, filter) {
  exitCode = exitCode || 1
  var ws
  if (filter) ws = Object.keys(workers).filter(w => filter.indexOf(w) > -1)
  else ws = Object.keys(workers)
  ws.forEach(w => {
    workers[w].kill(exitCode)
    delete workers[w]
  })
  var dir = fs.readdirSync('/tmp')
  dir.forEach(d => {
    if (d.indexOf('-server.sock') > -1) {
      fs.unlinkSync(`/tmp/${d}`)
    }
  })
}

function cleanupExit (exitCode, filter) {
  exitCode = exitCode || 1
  cleanup(exitCode, filter)
  log.Info('cleanup done. exiting.')
  process.exit(exitCode)
}

var rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', function(line) {
  if (line === 'help') {
    help
  } else if (line === 'exit') {
    cleanupExit(0)
  }
  if (line.indexOf('clear') !== -1) {
    if (line === 'clear') {
      log.Info('clearing all workers')
      cleanup(0)
    } else {
      var uname = line.split(' ')[1]
      log.Info(`clearing ${uname} worker`)
      cleanup(0, uname)
    }
    spawnGuldUserWorkers()
  }
})

function help () {
  process.stdout.write(`\nCommands: exit, clear, clear $username\n`)
}

fs.watchFile('/etc/htpasswd', spawnGuldUserWorkers)

spawnGuldUserWorkers()

log.Info(`guld super server listening for changes to /etc/htpasswd with pid ${process.pid}\n`)
help()