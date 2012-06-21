#!/usr/bin/env node

// Rather awful test which is tiding me over until I can get a proper test suite written.

var Castor = require("./index.js"),
	fs = require("fs");

fs.readFile("./testdoc.html",function(err,fileData) {
	if (err) throw err;

	var startTime = Date.now();
	var castorInstance = new Castor();
	castorInstance.parse(fileData);
	
	logTree(castorInstance.tree);

	function printAttr(tree) {
		var attrs = [];
		for (attrName in tree.attributes) {
			if (tree.attributes.hasOwnProperty(attrName)) {
				attrs.push(attrName + "='" + tree.attributes[attrName] + "'");
			}
		}

		return attrs.length ? " " + attrs.join(" ") : "";
	}

	function logTree(tree,depth) {
		var indent = "", depth = depth || 0;
		while (indent.length < depth) indent += "\t";
		
		if (tree.nodeType === 3) {
			if (tree.textContent.replace(/\s+/ig,"").length) {
				console.log(indent + tree.textContent.replace(/\s+/ig," "));
			}
		} else if (tree.nodeType === 8) {
			console.log(indent + "<!-- " + tree.textContent.replace(/\s+/ig," ") + " -->");
		} else if (tree.nodeType === 1) {
			var nodeAttributes = printAttr(tree);
			console.log(indent + "<" + tree.tagName + nodeAttributes + (tree.childNodes.length ? "" : "/") + ">");
		} else if (tree.nodeType === 99) {
			// Ignore document node, but decrement depth to balance tree...
			depth --;
		} else {
			console.log(indent + "<? [[ " + tree.nodeType + ":" + tree.nodeValue + " ]] ?>");
		}
		
		if (tree && tree.childNodes && tree.childNodes.length) {
			tree.childNodes.forEach(function(node) {
				logTree(node,depth+1);
			});
		
			if (tree.nodeType === 1) {
				console.log(indent + "</" + tree.tagName + ">");
			}
		}
	};
});