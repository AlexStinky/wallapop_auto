const os = require('os');
const nets = os.networkInterfaces();
for (const name of Object.keys(nets)) {
  for (const net of nets[name]) {
    if (net.family === 'IPv4' && !net.internal) {
      console.log(net.address);
      process.exit(0);
    }
  }
}
