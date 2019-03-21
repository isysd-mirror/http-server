const { spawn } = require('child_process')
var os = global.os = require('os')
var path = global.path = require('path')
const home = os.homedir()
const express = require('express')
var bodyParser = require('body-parser')
const app = express()
const { getName, getFullName, validate, exists, getHosts } = require('guld-user')
var auth = require('http-auth')
const nodefs = require('fs')
const { getFS } = require('guld-fs')
var url = require('url')
const keyring = require('keyring-gpg')
const { getRandStr } = require('guld-random')
const log = require('node-file-logger')

let fs
let client
let clientReady = false
let GULDNAME
let repos
var decodePack = require('js-git/lib/pack-codec').decodePack;

async function setupLogging (gname) {
  GULDNAME = GULDNAME || gname
  process.chdir(`/var/log/guld/@${GULDNAME}`)
  const options = {
    folderPath: `./`,
    dateBasedFileNaming: true,
    fileNamePrefix: `http-server-`,
    fileNameSuffix: '',
    fileNameExtension: '.log',
    dateFormat: 'YYYY-MM-DD',
    timeFormat: 'HH:mm:ss.SSS',
    logLevel: 'debug',
    onlyFileLogging: false
  }
  log.SetUserOptions(options)
}

const basic = auth.basic({
    realm: 'guld',
    file: "/etc/htpasswd"
})

async function getSalt () {
  return getRandStr(8)
}

async function hashPasswd (passwd) {
  var passwdp = spawn('openssl', ['passwd', '-6', '-salt', await getSalt()]);
  var hash = ''
  passwdp.stdout.on('data', function(data) {
      hash += data
  });
  passwdp.stderr.on('data', function(data) {
    throw new Error(data)
  });
  passwdp.on('exit', function() {
    return hash
  });
}

async function htpasswd (user, passwd) {
  var hash = await hashPasswd(passwd)
  fs = fs || await getFS()
  var htpasswd = await fs.readFile(`/@${user}/etc/htpasswd`)
  var ure = new RegExp(`^${user}:*`)
  if (htpasswd.match(ure)) {
    await fs.writeFile(`/@${user}/etc/htpasswd`, htpasswd.replace(ure, `${user}:${hash}`))
  }
}

async function dirhandler (req, res) {
  fs = fs || await getFS()
  var flist = await fs.readdir(req.path)
  if (flist) res.send(JSON.stringify(flist))
  else res.status(404).send('not a directory')
}

async function filehandler (req, res) {
  res.sendFile(req.path, function (err) {
    if (err) res.status(404).send(`No ${req.path} found`)
  })
}

async function indexhandler (req, res) {
  fs = fs || await getFS()

  // return index if one actually exists
  let index = await fs.readFile(path.join(home, path.dirname(req.path), 'index.html'), 'utf-8').catch(e => undefined)
  if (index) return res.send(index)

  // otherwise, try to generate it from the manifest
  let manifest = await fs.readFile(path.join(home, path.dirname(req.path), 'manifest.json'), 'utf-8').catch(e => {
    res.status(404).send(`No manifest found`)
  })
  if (manifest) return res.send(manifestToHtml(manifest))
}

const _hex = '0123456789abcdef'

async function gitInfoRefs (req, res) {
  var pname = req.path.slice(0,-10)
  if (req.query.service === undefined || req.query.service.length === 0 || req.query.service.slice(0, 4) !== 'git-') {
    return res.status(500).send('500 INTERNAL ERROR')
  }
  res.set('Expires', 'Fri, 01 Jan 1980 00:00:00 GMT')
  res.set('Pragma', 'no-cache')
  res.set('Cache-Control', 'no-cache, max-age=0, must-revalidate')
  res.set('Content-Type', `application/x-${req.query.service}-advertisement`)
  res.status(200)

  var packet = `# service=${req.query.service}\n`
  var length = packet.length + 4
  var prefix = ''
  prefix += _hex[length >> 12 & 0xf]
  prefix += _hex[length >> 8  & 0xf]
  prefix += _hex[length >> 4 & 0xf]
  prefix += _hex[length & 0xf]
  var data = prefix + packet + '0000'
  res.write(data)

  var gitp = spawn(req.query.service, ['--stateless-rpc', '--advertise-refs', pname]);
  gitp.stdout.on('data', function(data) {
      res.write(data);
  });
  gitp.stderr.on('data', function(data) {
    log.Info("git-info-refs stderr: " + data);
  });
  gitp.on('exit', function() {
    res.end();
  });
}

app.get(/.*\.git\/info\/refs/, gitInfoRefs)

// auth.connect(basic)
app.get('*', async function (req, res) {
  if (req.path.match(/.*\.git\/info\/refs/)) {
    return gitInfoRefs(req, res)
  } else {
    fs = fs || await getFS()
    var fstat = await fs.stat(req.path).catch(e => {
      log.Error(e)
    })
    if (fstat && fstat.isFile()) return filehandler(req, res)
    else if (fstat && fstat.isDirectory()) return dirhandler(req, res)
    else return res.status(404).send('record not found')
  }
/*
  GULDNAME = GULDNAME || await getName()
  let status = await git.status({dir: dir, filepath: req.repopath}).catch(e => {
    res.status(404).send(`Unable to find ${req.url}`)
  })
  if (status && status === 'unmodified') res.sendFile(path.join(dir, req.repopath), {dotfiles: 'allow'})
  else {
    res.status(404).send(`Unable to find ${req.url}`)
  }*/
})

const PGPSIGBEGIN = '-----BEGIN PGP SIGNATURE-----\n'
const PGPSIGEND = '-----END PGP SIGNATURE-----\n'

function parse_commit_chunk(commit) {
  var resp = {}
  commit = commit.replace(/^\n+|\n+$/, '').replace(/\r/g, '') + '\n'
  resp.message = commit.slice(commit.indexOf(PGPSIGEND) + PGPSIGEND.length)
  resp.headers = commit.slice(0, commit.indexOf('\ngpgsig'))
  var sigstart = commit.indexOf(PGPSIGBEGIN)
  var sigend = commit.indexOf(PGPSIGEND) + PGPSIGEND.length
  resp.sig = commit.slice(sigstart, sigend).split('\n').map(x => x.replace(/^ /, '')).join('\n')
  resp.orig = (resp.headers + '\n' + resp.message).replace(/^\n|\n$/, '') + '\n'
  resp.commit = commit
  return resp
}

async function parseFingerprints (user, defaultWeight=1) {
  user = user || GULDNAME || await getUser()
  fs = fs || await getFS()
  var fingerprints = {}
  var fprs = await fs.readFile(`/@${user}/etc/fingerprint` , 'utf-8')
  fprs.split('\n').forEach(f => {
    if (f.indexOf(':') > -1) {
      var fprsa = f.split(':')
      fingerprints[fprsa[0]] = parseInt(fprsa[1])
    } else if (f.length > 2) {
      fingerprints[f] = defaultWeight
    }
  })
  return fingerprints
}

app.post(/.*\.git\/git-receive-pack/, (req, res) => {
  var pname = req.path.slice(0,-17)
  var packidx = new Buffer([])
  var packfile = new Buffer([])
  var inpack = false
  var upack = []
  var write = decodePack(onItem);
  req.on("data", (d) => {
    packfile = Buffer.concat([packfile, d])
    if (!inpack && packfile.indexOf(Buffer.from('PACK')) > -1) {
      packidx = packfile.slice(0, packfile.indexOf(Buffer.from('PACK')))
      packfile = packfile.slice(packfile.indexOf(Buffer.from('PACK')))
      inpack = true
    }
    if (inpack) {
      write(packfile)
    }
  });
  req.on("end", async (item) => {
    if (item) upack.push(item)
    var fingerprints = await parseFingerprints()
    var signers = Object.keys(fingerprints)
    var weights = Object.values(fingerprints).map(f => parseInt(f))
    var wsum = weights.reduce((a,b) => a + b, 0)
    var votes
    if (!(await Promise.all(upack.map(async (up) => {
      if (up.type === 'commit') {
        // found a commit! check for gpg signatures!
        var com = parse_commit_chunk(up.body.toString())
        if (!com.sig || com.sig.length === 0) {
          throw new Error(`No known signatures found.`)
        }
        votes = await keyring.verifyWeight(com.orig, com.sig, signers.slice(), weights.slice())
        if (votes * 10 < wsum * 5) {
          throw new Error(`Insufficient signatures. Only ${votes} out of ${wsum}`)
        } else {
          process.stdout.write(`${votes} out of ${wsum}\n`)
        }
      }
    })).catch(e => {
      log.Error(e.toString())
      res.status(403).send(e.toString()).end()
    }))) return
    res.set('Expires', 'Fri, 01 Jan 1980 00:00:00 GMT')
    res.set('Pragma', 'no-cache')
    res.set('Cache-Control', 'no-cache, max-age=0, must-revalidate')
    res.set('Content-Type', `application/x-git-receive-pack-result`)
    res.status(200)
    var gitp = spawn('git-receive-pack', ['--stateless-rpc', pname])
    if (req.headers['content-encoding'] == 'gzip') {
      // TODO refactor pipe
      req.pipe(zlib.createGunzip()).pipe(gitp.stdin)
    } else {
      gitp.stdin.write(Buffer.concat([packidx, packfile]))
    }
    gitp.stdout.pipe(res)
    gitp.stderr.on('data', function(data) {
      log.Info("git-receive-pack stderr: " + data)
    })
    gitp.on('exit', function() {
      res.end()
    })
  })
  var meta;
  function onItem(item) {
    if (meta === undefined) {
      meta = item;
    }
    else {
      upack.push(item)
    }
  }
})

app.post(/.*\.git\/git-upload-pack/, (req, res) => {
  res.set('Expires', 'Fri, 01 Jan 1980 00:00:00 GMT')
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
  res.setHeader('Content-Type', 'application/x-git-upload-pack-result');
  res.status(200)
  var pname = req.path.slice(0,-16)
  var gitp = spawn('git-upload-pack', ["--stateless-rpc", pname]);
  if (req.headers['content-encoding'] == 'gzip') {
    req.pipe(zlib.createGunzip()).pipe(gitp.stdin);
  } else {
    req.pipe(gitp.stdin);
  }
  gitp.stdout.pipe(res);
  gitp.stderr.on('data', function (data) {
    log.Info("git-upload-pack stderr: " + data);
  });
  gitp.on('exit', function() {
    res.end();
  });
})

app.get(/.*\.git\/*/, filehandler)

async function run () {
  GULDNAME = GULDNAME || await getName()
  await setupLogging(GULDNAME)
  log.Info(`guld https server listening on /tmp/${GULDNAME}-server.sock with pid ${process.pid}`)
  process.umask('0002')
  app.listen(`/tmp/${GULDNAME}-server.sock`)
}

run()