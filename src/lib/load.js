const path = require("path");
const fs = require("fs-extra");
const request = require("request-promise");
const xmldoc = require("xmldoc");
const lzma = require("lzma-native");

const load = (hash_path, relativePath, solr_endpoint, core) => new Promise(async (resolve, reject) => {
  const zipFilePath = `${path.join(hash_path, relativePath)}.xml.xz`;
  console.log(`Loading ${zipFilePath} into solr`);

  console.log("Unzipping files");
  const zipFile = fs.readFileSync(zipFilePath);
  const data = await lzma.decompress(zipFile);

  console.log("Parsing xml");
  const hashList = (new xmldoc.XmlDocument(data)).children
    .filter((child) => child.name === "doc")
    .map((doc) => {
      const fields = doc.children.filter((child) => child.name === "field");
      return {
        time: parseFloat(fields.filter((field) => field.attr.name === "id")[0].val),
        cl_hi: fields.filter((field) => field.attr.name === "cl_hi")[0].val,
        cl_ha: fields.filter((field) => field.attr.name === "cl_ha")[0].val
      };
    })
    .sort((a, b) => a.time - b.time);

  const dedupedHashList = [];
  hashList.forEach((currentFrame) => {
    if (
      !dedupedHashList
        .slice(-24) // get last 24 frames
        .filter((frame) => currentFrame.time - frame.time < 2) // select only frames within 2 sec
        .some((frame) => frame.cl_hi === currentFrame.cl_hi) // check for exact match frames
    ) {
      dedupedHashList.push(currentFrame);
    }
  });

  const xml = [
    "<add>",
    dedupedHashList
      .map((doc) =>
        [
          "<doc>",
          "<field name=\"id\">",
          `<![CDATA[${relativePath}/${doc.time.toFixed(2)}]]>`,
          "</field>",
          "<field name=\"cl_hi\">",
          doc.cl_hi,
          "</field>",
          "<field name=\"cl_ha\">",
          doc.cl_ha,
          "</field>",
          "</doc>"
        ].join("")
      )
      .join("\n"),
    "</add>"
  ].join("\n");

  // fs.writeFileSync("debug.xml", xml);

  const coreInfo = await request({
    method: "GET",
    uri: `${solr_endpoint}admin/cores?wt=json`,
    json: true
  });

  const selectedCoreName = Object.values(coreInfo.status)
    .filter((e) => e.name.indexOf(`${core}_`) === 0)
    .sort((a, b) => a.index.numDocs - b.index.numDocs)[0].name; // choose least populated core

  console.log(`Uploading xml to solr core ${selectedCoreName}`);
  const response = await request({
    method: "POST",
    uri: `${solr_endpoint}${selectedCoreName}/update?wt=json`,
    headers: {"Content-Type": "text/xml"},
    body: xml
  });
  if (!response) {
    reject(new Error());
  }

  const commit = await request({
    method: "POST",
    uri: `${solr_endpoint}${selectedCoreName}/update?wt=json`,
    headers: {"Content-Type": "text/xml"},
    body: "<commit/>"
  });
  if (!commit) {
    reject(new Error());
  }

  console.log("Completed");
  resolve();
});

module.exports = {load};
