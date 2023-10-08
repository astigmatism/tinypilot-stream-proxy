var express = require('express');
var http = require('http');
var https = require('https');
var url = require('url');
var app = express();

process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'

// #region mjpeg-proxy

function extractBoundary(contentType) {
    contentType = contentType.replace(/\s+/g, '');

    var startIndex = contentType.indexOf('boundary=');
    var endIndex = contentType.indexOf(';', startIndex);
    if (endIndex == -1) { // boundary is the last option
        // some servers, like mjpeg-streamer, put a '\r' character at the end of each line.
        if ((endIndex = contentType.indexOf('\r', startIndex)) == -1) {
        endIndex = contentType.length;
        }
    }
    return contentType.substring(startIndex + 9, endIndex).replace(/"/gi,'').replace(/^\-\-/gi, '');
}

var MjpegProxy = function(mjpegUrl) {
    var self = this;

  if (!mjpegUrl) throw new Error('Please provide a source MJPEG URL');

  self.mjpegOptions = new URL(mjpegUrl);

  self.audienceResponses = [];
  self.newAudienceResponses = [];

  self.boundary = null;
  self.globalMjpegResponse = null;
  self.mjpegRequest = null;

  self.proxyRequest = function(req, res) {
    if (res.socket == null) {
      return;
    }

    // There is already another client consuming the MJPEG response
    if (self.mjpegRequest !== null) {
      self._newClient(req, res);
    } else {
      // Determine if we should use HTTP or HTTPS based on the protocol
      var requester = self.mjpegOptions.protocol === 'https:' ? https : http;

      // Send source MJPEG request
      self.mjpegRequest = requester.request(self.mjpegOptions, function(mjpegResponse) {
        self.globalMjpegResponse = mjpegResponse;
        self.boundary = extractBoundary(mjpegResponse.headers['content-type']);

        self._newClient(req, res);

        var lastByte1 = null;
        var lastByte2 = null;

        mjpegResponse.on('data', function(chunk) {
          // Fix CRLF issue on iOS 6+: boundary should be preceded by CRLF.
          var buff = Buffer.from(chunk);
          if (lastByte1 != null && lastByte2 != null) {
            var oldheader = '--' + self.boundary;
            var p = buff.indexOf(oldheader);

            if (p == 0 && !(lastByte2 == 0x0d && lastByte1 == 0x0a) || p > 1 && !(chunk[p - 2] == 0x0d && chunk[p - 1] == 0x0a)) {
              var b1 = chunk.slice(0, p);
              var b2 = Buffer.from('\r\n--' + self.boundary);
              var b3 = chunk.slice(p + oldheader.length);
              chunk = Buffer.concat([b1, b2, b3]);
            }
          }

          lastByte1 = chunk[chunk.length - 1];
          lastByte2 = chunk[chunk.length - 2];

          for (var i = self.audienceResponses.length; i--;) {
            var res = self.audienceResponses[i];

            // First time we push data... lets start at a boundary
            if (self.newAudienceResponses.indexOf(res) >= 0) {
              var p = buff.indexOf('--' + self.boundary);
              if (p >= 0) {
                res.write(chunk.slice(p));
                self.newAudienceResponses.splice(self.newAudienceResponses.indexOf(res), 1);
              }
            } else {
              res.write(chunk);
            }
          }
        });
        mjpegResponse.on('end', function() {
          for (var i = self.audienceResponses.length; i--;) {
            var res = self.audienceResponses[i];
            res.end();
          }
        });
      });

      self.mjpegRequest.on('error', function(e) {
        console.error('problem with request: ', e);
      });
      self.mjpegRequest.end();
    }
  }

  self._newClient = function(req, res) {
    res.writeHead(200, {
      'Expires': 'Mon, 01 Jul 1980 00:00:00 GMT',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Content-Type': 'multipart/x-mixed-replace;boundary=' + self.boundary
    });

    self.audienceResponses.push(res);
    self.newAudienceResponses.push(res);

    res.socket.on('close', function() {
      self.audienceResponses.splice(self.audienceResponses.indexOf(res), 1);
      if (self.newAudienceResponses.indexOf(res) >= 0) {
        self.newAudienceResponses.splice(self.newAudienceResponses.indexOf(res), 1);
      }

      if (self.audienceResponses.length == 0) {
        self.mjpegRequest = null;
        if (self.globalMjpegResponse) {
          self.globalMjpegResponse.destroy();
        }
      }
    });
  }
}

// #endregion

// Assuming you provide the MJPEG URL as the first command line argument
var port = process.argv[2];
var mjpegUrl = process.argv[3];

if (!mjpegUrl) {
    console.error("Please provide the MJPEG URL as a command line argument.")
    process.exit(1);
}

app.get('/', new MjpegProxy(mjpegUrl).proxyRequest);
app.listen(port, () => {
    console.log(`Server is running on port ${port} and proxying ${mjpegUrl}`)
})
