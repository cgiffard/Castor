// Castor HTML/XML Parser
// Ultra-simple HTML/XML parser. Generates a DOM-like (but extremely simplified and not at all compliant) tree.
// Use in cases where you can't afford the additional weight of a real DOM builder.
// 
// The ultimate goal is to make this streamable. But it's not there yet.
// WARNING: This is very "under-development-ish".
//
// Christopher Giffard 2012

(function(glob) {
	
	"use strict";
	
	// Some grammar-related constants...
	
	// Parser internal states
	var STATE_UNINITIALISED 			= 0,
		STATE_EXPECTING_TAG				= 1,
		STATE_EXPECTING_BANG_QUALIFIER	= 2,
		STATE_WITHIN_DOCTYPE			= 3,
		STATE_WITHIN_XML_INSTRUCTION	= 4,
		STATE_WITHIN_CDATA				= 5,
		STATE_WITHIN_COMMENT			= 6,
		STATE_EXPECTING_ELEMENT_NAME	= 7,
		STATE_EXPECTING_ATTRIBUTE_NAME	= 8,
		STATE_EXPECTING_ATTRIBUTE_VALUE	= 9,
		STATE_EXPECTING_ELEMENT_CLOSE	= 10;
	
	// Nodes which should be considered implicitly self-closing	
	// Taken from http://www.whatwg.org/specs/web-apps/current-work/multipage/syntax.html#void-elements
	var voidElements = [
		"area", "base", "br", "col", "command", "embed", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr"
	];
	
	// Omission map (end tags)
	// Determines which tags will automatically be closed when another begins, and by which sibling tags they will be closed.
	// Taken from http://www.whatwg.org/specs/web-apps/current-work/multipage/syntax.html#syntax-tag-omission
	var omissionMap = {
		"head":		[ "body" ],
		"li":		[ "li" ],
		"dt":		[ "dt", "dd" ],
		"dd":		[ "dt", "dd" ],
		"p":		[
			"address", "article", "aside", "blockquote", "dir",
			"div", "dl", "fieldset", "footer", "form",
			"h1", "h2", "h3", "h4", "h5", "h6", "header",
			"hgroup", "hr", "menu", "nav", "ol", "p", "pre",
			"section", "table", "ul"
		],
		"rt":		[ "rt", "rp" ],
		"rp":		[ "rt", "rp" ],
		"optgroup":	[ "optgroup" ],
		"option":	[ "optgroup", "option" ],
		"thead":	[ "tbody", "tfoot" ],
		"tr":		[ "tr" ],
		"td":		[ "td", "th" ],
		"th":		[ "td", "th" ]
	}
	
	// Node type/class
	// Based on DOM, but doesn't implement _ANY_ of the DOM functions.
	var Node = function(nodeType,tagParameter) {
		this.nodeType		= typeof nodeType === "number" ? nodeType : 1;
		this.tagName		= typeof tagParameter === "string" && nodeType === 1 ? tagParameter : null;
		this.parentNode		= null;
		this.childNodes 	= [];
		this.attributes 	= {};
		this.textContent	= nodeType !== 1 && typeof tagParameter === "string" ? tagParameter : "";
	
		// Custom stuff for heuristics...
		this.weight = 0;
		this.flatness = 0;
	};
	
	// Helper function that implicitly empty nodes to determine whether they should be closed or not.
	function isVoidNode(node) {
		node = node instanceof Node ? node.tagName : node;
	
		for (var nodeTypeIndex = 0; nodeTypeIndex < voidElements.length; nodeTypeIndex ++) {
			if (voidElements[nodeTypeIndex].toLowerCase() === node.toLowerCase()) return true;
		}
	
		return false;
	}
	
	// Determines whether a tag should close and become a sibling of the current node, or become
	// a child of the current node.
	function closesCurrentNode(tagName,currentTagName) {
		var closesNode = false;
	
		if (omissionMap[currentTagName]) {
			for (var testIndex = 0; testIndex < omissionMap[currentTagName].length; testIndex ++) {
				if (omissionMap[currentTagName][testIndex].toLowerCase() === tagName.toLowerCase()) return true;
			}
		}
	
		// The current node doesn't exist in the map or isn't closed but the specified tag.
		return false;
	}
	
	// Define Castor itself...
	// State parameters hang off the main Castor object.
	// Any functions which act on or are dependant on parser state are implemented as prototype
	// methods of Castor. Anything which can act independently of state is written separately.
	
	var Castor = function() {
		this.doctype = null;
		
		// Variables for managing parser state...
		this.tree				= new Node(99,"document"); // '99' is just a node number I've made up for the document node.
		this.state				= 0;
		this.prevState			= 0;
		this.tokenBuffer		= "";
		this.prevToken			= "";
		this.currentNode		= this.tree;
		this.currentAttribute	= "";
		this.currentDelimiter	= "";
		this.treeDepth			= 0;
		this.curChar			= "";
		this.prevChar			= "";
		this.prevChar2			= "";
		
		// These two are just for debugging.
		this.lineNo				= 0;
		this.colNo				= 0;
	};
	
	// Helper function for altering the internal state of the parser.
	Castor.prototype.setState = function(newState) {
		this.prevState = this.state;
		this.state = newState;
	};
	
	
	// Hides buffer implementation (in case native buffers are eventually used.)
	Castor.prototype.buffer = function(c) {
		this.tokenBuffer += c;
	};
	
	
	// Retrieves the current token buffer
	Castor.prototype.getBuffer = function() {
		return this.tokenBuffer;
	};
	
	
	// Destroys anything in the buffer.
	Castor.prototype.clearBuffer = function() {
		this.tokenBuffer = "";
	};
	
	
	// Creates a new text node at the current depth with the buffer contents,
	// then clears it.
	Castor.prototype.flushBuffer = function() {
		// Create a new text node as a child of the current node...
		// but only if there's something in there!
		if (this.getBuffer().length) {
			var textNode = new Node(3,this.getBuffer());
			textNode.parentNode = this.currentNode;
			this.currentNode.childNodes.push(textNode);
		}
	
		this.clearBuffer();
	}
	
	
	// Closes the current node, but also scans up the stack (if a closing tag name was provided) to ensure it's balanced.
	Castor.prototype.closeNode = function(closingTagName) {
		// If we haven't got a closing tag name, we're dealing with a self-closing tag or similar.
		// Just take the name of the current node.
		closingTagName = !!closingTagName ? closingTagName : this.currentNode.tagName;
		var nodeFound = false;
		var tmpCurrentNode = this.currentNode, tmpTreeDepth = this.treeDepth;
	
		// Repeat while we haven't reached the top of the tree yet, or found the node we're looking to close.
		while (tmpTreeDepth && !nodeFound) {
			if (tmpCurrentNode.tagName === closingTagName) {
				nodeFound = true;
			}
	
			if (tmpCurrentNode.parentNode) {
				tmpCurrentNode = tmpCurrentNode.parentNode;
				tmpTreeDepth --;
			}
		}
		
		// If we actually found the node we were looking for...
		if (nodeFound) {
			this.currentNode = tmpCurrentNode;
			this.treeDepth = tmpTreeDepth;
			return true;
		}
		
		return false;
	}
	
	
	// Bailout on error.
	// Generates an error describing where the error was...
	Castor.prototype.bailout = function(message) {
		throw new Error("Unexpected token at line " + this.lineNo + ", column " + this.colNo + ": '" + this.curChar + "'. Parser state was: " + this.state + (message && message.length ? "\n" + message : ""));
	}
	
	
	
	// The actual parser function.
	
	Castor.prototype.parse = function(sourceInput) {
		var self = this;
		var charIndex = 0;
		
		sourceInput = typeof sourceInput === "string" ? sourceInput : sourceInput.toString();
		
		// Kick off the parser!
		
		while (charIndex < sourceInput.length) {
	
			// Fetch most recent three characters, push previous characters back on the stack...
			self.prevChar2 = self.prevChar;
			self.prevChar = self.curChar;
			self.curChar = sourceInput.substr(charIndex,1);
	
			if (self.curChar === "\n") {
				self.lineNo ++;
				self.colNo = 0;
			} else {
				self.colNo ++;
			}
	
			switch (self.state) {
				case STATE_UNINITIALISED:
	
					// Parser is just collecting text in uninitialised mode.
					if (self.curChar === "<") {
	
						// Open tag of some description
						// Could be an element, processing instruction, comment,
						// CDATA or DOCTYPE
	
						self.setState(STATE_EXPECTING_TAG);
	
					} else {
	
						// Character wasn't an instruction, so we'll save it to our token buffer.
	
						self.buffer(self.curChar);
					}
	
	
					break;
	
				case STATE_EXPECTING_TAG:
	
					if (self.curChar === "!") {
						
						// We've got a 'bang' tag on our hands.
						// Wait for the character after this to determine what we're dealing with...
						// This could be a comment or a doctype.
						self.setState(STATE_EXPECTING_BANG_QUALIFIER);
						
					} else if (self.curChar === "?") {
						
						// We've got an XML processing instruction on our hands.
						// For now, we just ignore these. Not like I need 'em for this anyway.
						
						self.setState(STATE_WITHIN_XML_INSTRUCTION);
						
					} else if (self.curChar.match(/[a-z0-9]/i)) {
						
						// Looks like an element node. Flush current buffer to tree and get ready to handle element name...
						self.flushBuffer();
						self.buffer(self.curChar);
						self.setState(STATE_EXPECTING_ELEMENT_NAME);
	
					} else if (self.curChar === "/") {
	
						// Looks like a closing tag.
						self.setState(STATE_EXPECTING_ELEMENT_CLOSE);
	
						// Buffer any previous text if it exists...
						self.flushBuffer();
	
					} else if (self.curChar.match(/\s/)) {
	
						// The character after the tag was whitespace. We assume the tag is text (unescaped &lt; character!)
						// and buffer up the previous and current character before dropping back to 'uninitialised' state.
	
						self.buffer(self.prevChar);
						self.buffer(self.curChar);
						self.setState(STATE_UNINITIALISED);
	
					} else {
	
						// We weren't expacting this character here. Bail out!
						self.bailout();
					}
	
					break;
	
	
				// 3 node types start with <!. Wait for next character to determine what this is.
				case STATE_EXPECTING_BANG_QUALIFIER:
	
					if (self.curChar === "D" || self.curChar === "d") {
	
						// This looks like a DOCTYPE!
						self.flushBuffer();
						self.buffer(self.curChar);
						self.setState(STATE_WITHIN_DOCTYPE);
	
					} else if (self.curChar === "-") {
	
						// This looks like a comment!
						self.setState(STATE_WITHIN_COMMENT);
	
					} else {
	
						// Uh...
						self.bailout();
					}
	
					break;
	
				case STATE_WITHIN_DOCTYPE:
	
					if (self.curChar === ">") {
	
						// That's the end of our doctype! Save it and move on...
						self.doctype = self.getBuffer();
						self.clearBuffer();
						self.setState(STATE_UNINITIALISED);
	
					} else {
						// Do we even pay attention to doctypes?
						self.buffer(self.curChar);
					}
	
					break;
	
				case STATE_WITHIN_XML_INSTRUCTION:
					
					bailout("XML instructions not yet supported.");
	
					break;
	
				case STATE_WITHIN_CDATA:
				
					bailout("CDATA not yet supported.");
	
					break;
	
				case STATE_WITHIN_COMMENT:
	
					if (self.curChar === "-") { 
	
						// Do nothing for now. We'll work out whether we're going to buffer this
						// as part of the comment later.
	
					} else if (self.curChar === ">") {
	
						if (self.prevChar === "-" && self.prevChar2 === "-") {
	
							// OK then - that's the end of the comment!
							// Create a new comment node with the contents of the buffer.
	
							if (self.getBuffer().length) {
								var newComment = new Node(8,self.getBuffer());
								newComment.parentNode = self.currentNode;
								self.currentNode.childNodes.push(newComment);
								self.clearBuffer();
							}
	
							// Revert to uninitialised state.
							self.setState(STATE_UNINITIALISED);
	
						} else {
							self.buffer(self.curChar);
						}
	
					} else {
	
						// Because we don't buffer "-" characters immediately (in case they're part of the closing token)
						// we wait until we know it isn't followed by another "-", and then we buffer it.
	
						if (self.prevChar === "-" && self.curChar !== "-" && !self.curChar.match(/\s/)) {
							self.buffer(self.prevChar);
						}
	
						self.buffer(self.curChar);
					}
	
					break;
	
				case STATE_EXPECTING_ELEMENT_NAME:
	
					if (self.curChar.match(/[a-z0-9]/i)) {
						// Just a text character. Buffer up!
						self.buffer(self.curChar);
	
					} else {
	
						// Get the element name from the buffer...
						var elementName = self.getBuffer();
	
						// If this tag implicitly closes the currently open node
						if (closesCurrentNode(elementName,self.currentNode.tagName)) {
	
							// Then close the currently open node first.
							self.closeNode()
						}
	
	
						// Create element node with the buffer as its tagName
						// Assign the current node as its parent...
						var newElement = new Node(1,elementName);
						newElement.parentNode = self.currentNode;
						self.currentNode.childNodes.push(newElement);
						self.clearBuffer();
	
						// Set as the current node
						self.currentNode = newElement;
	
						// Increase our tree-depth for tracking/debugging
						self.treeDepth ++;
	
						if (self.curChar === ">") {
							// If we're an attribute-less opening tag, just switch back to uninitialised state.
							self.setState(STATE_UNINITIALISED);
	
						} else if (self.curChar.match(/\s/)) {
							// If there's whitespace we must be expecting attributes!
	
							self.setState(STATE_EXPECTING_ATTRIBUTE_NAME);
	
						} else if (self.curChar === "/") {
							// We're a self-closing tag.
	
							self.setState(STATE_EXPECTING_ELEMENT_CLOSE);
	
						} else {
							// Error condition...
							self.bailout();
						}
					}
	
					break;
	
				case STATE_EXPECTING_ATTRIBUTE_NAME:
	
					if (self.curChar === "/") {
						// Oh, it was just some whitespace before the end of a self-closing tag.
						self.setState(STATE_EXPECTING_ELEMENT_CLOSE);
	
						// Well, we save it to the node if there was anything in the buffer!
						if (self.getBuffer().length) {
							// Save the buffer as a boolean attribute, and clear it.
							self.currentNode.attributes[self.getBuffer()] = true;
							self.clearBuffer();
						}
	
					} else if (self.curChar.match(/[a-z0-9\-]/i)) {
	
						// looks like an attribute name to me!
						// But wait. If the previous character was whitespace, and the previous state was also
						// STATE_EXPECTING_ATTRIBUTE_NAME, then it must have been a boolean attribute. Add it to the
						// current node. Otherwise, just buffer away!
	
						if (self.prevChar.match(/\s/) && self.prevState === STATE_EXPECTING_ATTRIBUTE_NAME) {
	
							// Well, we save it to the node if there was anything in the buffer!
							if (self.getBuffer().length) {
								// Save the buffer as a boolean attribute, and clear it.
								self.currentNode.attributes[self.getBuffer()] = true;
								self.clearBuffer();
							}
	
						}
	
						self.buffer(self.curChar);
	
					} else if (self.curChar.match(/\s/)) {
						// Ignore whitespace.
	
					} else if (self.curChar === "=") {
	
						// Looks like we're being primed for a value...
						self.setState(STATE_EXPECTING_ATTRIBUTE_VALUE);
	
						// Capture and clear the buffer...
						self.currentAttribute = self.getBuffer();
						self.clearBuffer();
	
					} else if (self.curChar === "'" || self.curChar === "\"") {
	
						// Some idiot just stuck a string delimiter directly after an attribtue name without an equals sign.
						// Never mind, we can deal with that.
	
						if (self.getBuffer().length) {
							// Well handling it this way only makes sense if we've actually got something in the buffer
							// to use as an attribute name. Otherwise there's nothing to attach the attribute value to.
	
							self.currentDelimiter = self.curChar;
							self.setState(STATE_EXPECTING_ATTRIBUTE_VALUE);
							
							// Capture and clear the buffer...
							self.currentAttribute = self.getBuffer();
							self.clearBuffer();
						}
	
					} else if (self.curChar === ">") {
						// So the element was closed.
						// If there's anything in the buffer, consider it a boolean attribute.
	
						if (self.getBuffer().length) {
							// Save the buffer as a boolean attribute, and clear it.
							self.currentNode.attributes[self.getBuffer()] = true;
							self.clearBuffer();
						}
	
						if (isVoidNode(self.currentNode) && self.currentNode.parentNode) {
							self.currentNode = self.currentNode.parentNode;
						}
	
						// Return to uninitialised state.
						self.setState(STATE_UNINITIALISED);
					}
	
					break;
	
				case STATE_EXPECTING_ATTRIBUTE_VALUE:
	
					// Are we in a delimited string?
	
					if (self.currentDelimiter.length) {
						if (self.curChar === self.currentDelimiter) {
	
							self.currentDelimiter = "";
	
							if (self.getBuffer().length) {
								// In that case, save the buffer to the node attributes and start looking for more!
								self.currentNode.attributes[self.currentAttribute] = self.getBuffer();
								self.clearBuffer();
							}
	
							// Oh, we've reached a matching delimiter? Well that's the end of that then.
							self.setState(STATE_EXPECTING_ATTRIBUTE_NAME);
	
						} else {
							self.buffer(self.curChar);
						}
	
					} else {
						if (self.curChar === "/" || self.curChar === ">") {
	
							// We hit the end of the tag. Branch according to whether we're still expecting another character or not.
							if (self.curChar === "/") {
								self.setState(STATE_EXPECTING_ELEMENT_CLOSE);
							} else {
	
								// If this node is in our list of tag types to be implicitly closed, then close it.
								// Then switch back to STATE_UNINITIALISED.
	
								if (isVoidNode(self.currentNode)) {
									self.closeNode();
								}
	
								self.setState(STATE_UNINITIALISED);
							}
	
							// Is there actually something in the buffer?
							if (self.getBuffer().length) {
								self.currentNode.attributes[self.currentAttribute] = self.getBuffer();
	
							} else {
								// Couldn't extract a value? Treat this as a boolean attribute.
								self.currentNode.attributes[self.currentAttribute] = true;
							}
	
							self.clearBuffer();
	
						} else if (self.curChar === "'" || self.curChar === "\"") {
	
							// Hit a delimiter. If there's something in the buffer, consider the final delimiter
							// for a string with a missing first delimiter.
							if (self.getBuffer().length) {
								// In that case, save the buffer to the node attributes and start looking for more!
								self.currentNode.attributes[self.currentAttribute] = self.getBuffer();
								self.clearBuffer();
								self.setState(STATE_EXPECTING_ATTRIBUTE_NAME);
	
							} else {
	
								// Set the current string delimiter.
								// Nothing in the buffer, so no need to clear it!
								self.currentDelimiter = self.curChar;
	
							}
	
						} else if (self.curChar.match(/\s/)) {
							// Whitespace. If there's nothing in the buffer, we haven't gotten to the attribute value yet,
							// so we ignore it. If there's something in the buffer, we treat it as a delimiter, and switch
							// back to STATE_EXPECTING_ATTRIBUTE_NAME after saving the attribute value to the node.
	
							if (self.getBuffer().length) {
								self.currentNode.attributes[self.currentAttribute] = self.getBuffer();
								self.clearBuffer();
								self.setState(STATE_EXPECTING_ATTRIBUTE_NAME);
							}
						}
					}
	
					break;
	
				case STATE_EXPECTING_ELEMENT_CLOSE:
	
					if (self.curChar.match(/[a-z0-9]/i)) {
	
						// Dealing with a closing tag name? Just bufffer it.
						self.buffer(self.curChar);
	
					} else if (self.curChar === ">") {
	
						// Close the current node...
						// Pass in the tagName specified by the closing tag so we can ensure the tree is balanced...
						self.closeNode(self.getBuffer());
	
						// ...And return to uninitialised state.
						self.setState(STATE_UNINITIALISED);
	
						// And clear the buffer.
						self.clearBuffer();
	
					} else if (self.curChar.match(/\s/)) {
	
						// Ignore whitespace...
	
					} else {
						self.bailout();
					}
	
					break;
	
				default:
					// Something happened we weren't expecting.
					// Throw error condition?
					self.bailout();
			}
	
			// Increment parse pointer.
			charIndex ++;
		}
	
		// Return the finished parse tree to the calling function...
		return self.tree;
	};
	
	function castorExport() {
		return new Castor();
	}
	
	castorExport.Castor = Castor;
	
	(typeof module != "undefined" && module.exports) ? (module.exports = castorExport) : (typeof define != "undefined" ? (define("castor", [], function() { return castorExport; })) : (glob.castor = castorExport));
})(this);