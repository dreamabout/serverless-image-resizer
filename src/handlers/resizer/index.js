'use strict';

const AWS = require('aws-sdk');
const S3 = new AWS.S3({
  signatureVersion: 'v4',
});
const Sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const BUCKET = process.env.BUCKET;
const URL = process.env.URL;

function getResizeFunc(version, format, width, height, fit = 'contain', resizeOptions = {}, keepAlpha = false, isAnimated = true) {
  switch (version) {
    default:
    case 2:
    case 3:
      return async (data) => {
        const image = Sharp(data.Body, {animated: isAnimated});
        let alpha = 1;
        if (keepAlpha) {
          const metadata = await image.metadata();
          alpha = (metadata.hasAlpha ? 0 : 1);
        }

        let formatOptions = {};
        let background = {
          r: 255,
          g: 255,
          b: 255,
          alpha: alpha
        };
        let flattenedBackground = {background: '#FFFFFF'};
        switch (format) {
          case 'png':
            formatOptions = {progressive: true};
            break;
          case 'jpg':
            background = {
              r: 255,
              g: 255,
              b: 255,
            }
            formatOptions = {progressive: true, mozjpeg: true};
        }
        if (keepAlpha) {
          return image
            .resize(width || null, height || null, Object.assign({}, {
              fit: fit,
              background: background,
              fastShrinkOnLoad: false,
            }, resizeOptions))
            .toFormat(format, formatOptions).toBuffer({resolveWithObject: true});
        }
        return image
          .resize(width || null, height || null, Object.assign({}, {
            fit: fit,
            background: background,
            fastShrinkOnLoad: false,
          }, resizeOptions))
          .flatten(flattenedBackground)
          .toFormat(format, formatOptions).toBuffer({resolveWithObject: true});
      }
      break;
    case 1:
      return async (data) => {
        return Sharp(data.Body).resize(width || null, height || null).toBuffer({resolveWithObject: true});
      }
  }
}

function debug(message) {
  process.env.DEBUG && console.log(message);
}
const maxAge = 365 * 24 * 60 * 60;

exports.handler = function (event, context, callback) {
  let regexp = new RegExp(
    '^/?(?<shopId>\\d{1,3})(-(?<group>[\\w]+))?/((?<version>\\d{1})?/?)(images/)?(?<folder>products|blocks)/(?<width>\\d{1,4}[.\\d]{0,2})/(?<height>\\d{1,4}[.\\d]{0,2})/(?<path>[\\w\\.\\-]+)$', "i"
  );
  const key = event.queryStringParameters.key;
  const keepAlpha = event.queryStringParameters.keepAlpha || false;
  let originalKey = '';
  let match = key.match(regexp);
  let ContentType = '';
  const redirectKey = key.replace(/^\/*/, '');
  debug({"msg": "Seeing if it matches resize request", key, match, regexp})
  if (match === null) {
    regexp = new RegExp("^/?(?<shopId>\\d{1,3})(-(?<group>[\\w]+))?/files/(?<fileId>\\d{1,3})/(?<path>[\\w\\.\\-]+)$");
    match = key.match(regexp);
    if (match === null) {
      regexp = new RegExp("^/?(?<shopId>\\d{1,3})(-(?<group>[\\w]+))?/((?<version>\\d{1})?/?)images/(?<folder>[^/]+)/(?<path>[\\w\\.\\-]+)$");
      match = key.match(regexp);
      let path = match.groups.path;
      let pathParts = path.split('.');
      let format = pathParts[pathParts.length - 1];
      if (pathParts.length > 2) {
        format = pathParts.pop();
        path = pathParts.join('.');
      }
      let version = match.groups.version || 0;
      let width = 2000;
      let resizeFunc = getResizeFunc(version, format, width, 0, 'inside', {withoutEnlargement: true}, keepAlpha);
      originalKey = "catalog/" + match.groups.folder + "/images/" + path;
      return S3.getObject({Bucket: BUCKET, Key: originalKey}).promise()
        .then(resizeFunc)
        .then(buffer =>
          S3.putObject({
            Body: buffer.data,
            ContentType: (buffer.info || {format: "image/jpeg"}).format,
            Bucket: BUCKET,
            Key: key,
            CacheControl: `max-age=${maxAge}`,
          }).promise()
        )
        .then(() =>
          callback(null, {
            statusCode: '301',
            headers: {
              'location': `${URL}${redirectKey}`,
              'Cache-Control': "max-age=0",
            },
            body: '',
          })
        ).catch(err => {
          console.log(`Could not find key: ${originalKey}`);
          callback(err);
        });
    } else {
      originalKey = "files/" + match.groups.fileId + "/" + match.groups.path;
      ContentType = 'application/octet-stream';
      return S3.getObject({Bucket: BUCKET, Key: originalKey}).promise()
        .then(data =>
          S3.putObject({
            Body: data.Body,
            Bucket: BUCKET,
            Key: key,
            CacheControl: `max-age=${maxAge}`,
            ContentType: ContentType
          }).promise()
        )
        .then(() =>
          callback(null, {
            statusCode: '301',
            headers: {
              'location': `${URL}${redirectKey}`,
              'Cache-Control': "max-age=0",
            },
            body: '',
          })
        ).catch(err => {
          console.log(`Could not find key: ${originalKey}`);
          callback(err);
        });
    }
  }
  let width = parseInt(match.groups.width, 10);
  let height = parseInt(match.groups.height, 10);
  if (width === 0 && height === 0) {
    width = 2560;
  }
  let path = match.groups.path;
  let pathParts = path.split('.');
  let format = pathParts[pathParts.length - 1];
  if (pathParts.length > 2) {
    format = pathParts.pop();
    path = pathParts.join('.');
  }
  const folder = match.groups.folder;
  originalKey = "catalog/" + folder + "/images/" + path;
  let version = parseInt(match.groups.version || 1, 10);
  let resizeFunc = getResizeFunc(version, format, width, height);
  debug({version, path, folder, width, height, originalKey, format, matchGroups: match.groups});
  S3.getObject({Bucket: BUCKET, Key: originalKey}).promise()
    .then(resizeFunc)
    .then(buffer => S3.putObject({
        Body: buffer.data,
        Bucket: BUCKET,
        ContentType: (buffer.info || {format: "image/jpeg"}).format,
        Key: key,
        CacheControl: `max-age=${maxAge}`
      }).promise()
    )
    .then(() => callback(null, {
        statusCode: '301',
        headers: {
          'location': `${URL}${redirectKey}`,
          "Cache-Control": "max-age=0",
        },
        body: '',
      })
    )
    .catch(err => callback(err))
}

exports.onProductImageUpload = async function(event) {
    let records = event.Records;
    debug(JSON.stringify(event));
    let sizes= [[150,210],[200,280],[240,0],[240,336],[242,339],[340,0],[350,490],[384,538],[415,581],[450,630],[461,645],[480,0],[615,861],[680,0],[700,980],[768,0],[768,1075],[819,0],[819,1147],[900,1260],[920,0],[920,1288],[922,1291],[930,1302],[1200,1680],[1230,1722],[1280,0],[1280,1792],[1536,0],[1600,2240],[1638,0],[1840,0],[2560,0]];
    if(process.env.SIZES) {
      sizes = JSON.parse(process.env.SIZES);
    }
    let folder = 'products';
    let format = process.env.FORMAT || "avif";
    let version = 3;
  
    await Promise.all(records.map(record => {
      const origKey = record.s3.object.key;
      let origFilename = path.basename(origKey);
      let pathTemplate = `13/${version}/images/${folder}/{{width}}/{{height}}/${origFilename}.${format}`
      return S3.getObject({Bucket: record.s3.bucket.name, Key: origKey }).promise().then(
        (data) => {
          debug("Data has been loaded from S3, resizing image");
          let resizePromises = sizes.map((size) => {
            return getResizeFunc(version,format,size[0],size[1])(data)
              .then(
                buffer => {
                  let thumbKey = pathTemplate.replace('{{width}}', size[0]).replace('{{height}}', size[1]) 
                  debug(`Image has been resized to ${size.join("x")} and writing object ${thumbKey}`)    
                  return S3.putObject({
                  Body: buffer.data,
                  Bucket: BUCKET,
                  ContentType: (buffer.info || {format: "image/jpeg"}).format,
                  Key: thumbKey,
                  CacheControl: `max-age=${maxAge}`
                }).promise()
              })
            });
          
          return Promise.all(resizePromises);
        }
      )
    }));
}