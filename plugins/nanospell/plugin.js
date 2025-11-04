/*
 *  # NanoSpell Spell Check Plugin for CKEditor #
 *
 *  (C) Copyright nanospell.com (all rights reserverd)
 *  License:  http://ckeditor-spellcheck.nanospell.com/license
 *
 *
 *	# Resources #
 *
 *	Getting Started - http://ckeditor-spellcheck.nanospell.com
 *	Installation 	- http://ckeditor-spellcheck.nanospell.com/how-to-install
 *	Settings 		- http://ckeditor-spellcheck.nanospell.com/plugin-settings
 *	Dictionaries 	- http://ckeditor-spellcheck.nanospell.com/ckeditor-spellchecking-dictionaries
 *
 */
/*
 * A huge thanks To Frederico Knabben and all contributirs to CKEditor for releasing and maintaining a world class javascript HTML Editor.
 * FCK and CKE have enabled a new generation of online software , without your excelent work this project would be pointless.
 */

(function () {
	'use strict';

	var editorHasFocus = false;
	var spellDelay = 250;
	var spellFastAfterSpacebar = true;
	var commandIsActive = false;
	var lang = "en";
	var locale = {
		ignore: "Ignore",
		learn: "Add To Personal Dictionary",
		nosuggestions: "( No Spelling Suggestions )"
	};
	var spellcache = [];
	var suggestionscache = [];
	var ignorecache = [];
	var CHARCODES = {
		SPACE: 32,
		LF: 10,
		CR: 13,
	};
	var DEFAULT_DELAY = 50;
	var EVENT_NAMES = {
		START_SPELLCHECK_ON: 'startSpellCheckOn',
		START_SCAN_WORDS: 'startScanWords',
		START_CHECK_WORDS: 'startCheckWordsAjax',
		START_RENDER: 'startRender',
		SPELLCHECK_COMPLETE: 'spellCheckComplete',
		SPELLCHECK_ABORT: 'spellCheckAbort'
	};
	var DEFAULT_WORD_LIMIT_PER_REQUEST = 200;

	function normalizeQuotes(word) {
		return word.replace(/[\u2018\u2019]/g, "'");
	}

	function WordWalker(editor, range) {
		// the WordWalker takes a range encompassing a block element
		// (for example, p, li, td)
		// and provides a mechanism for iterating over each word within,
		// ignoring non-block elements.  (for example, span)
		var bookmarkGuardFn = CKEDITOR.dom.walker.bookmark(false, true);
		var startNode = range.startContainer;
		var ww = this;

		ww.hitWordBreak = false;
		ww.hitBookmark = false;
		ww.offset = 0;
		ww.origRange = range.clone();
		ww.editor = editor;

		var isBookmark = function(node) {
			// This function is required so that we can later retrieve
			// a reference to the bookmark which triggered the guard condition on the walker.
			// Otherwise we have to essentially re-implement the walker just to retrieve it.
			// (Suppose cases where the last word returned is followed by a number of invalid
			// elements, then a bookmark)
			var isNotBookmark = bookmarkGuardFn(node);
			if (!isNotBookmark) {
				ww.lastBookmark = node;
			}

			return isNotBookmark;
		};

		function isRootBlockTextNode(node) {
			// this function is an evaluator used to return only
			// the text nodes in the walker.
			// because of a special case around nested lists,
			// non-root block nodes must also be excluded.
			// the text content of ckeditor bookmarks must also be excluded
			// or &nbsp; will be added throughout.

			var path = new CKEDITOR.dom.elementPath(node, startNode),
				block = path.block,
				blockIsStartNode = block && block.equals(startNode),
				blockLimit = path.blockLimit,
				blockLimitIsStartNode = blockLimit && blockLimit.equals(startNode);

			// tables and list items can get a bit weird with getNextParagraph()
			// for example causing list item descendants to be included as part of the original list item
			// and also individually as their own paragraph-like elements
			// hence why the below condition is a bit complicated.

			var condition = node.type == CKEDITOR.NODE_TEXT && // it is a text node
				node.getLength() > 0 &&  // and it's not empty
				( !node.isReadOnly() ) &&   // or read only
				(blockLimit ? blockLimitIsStartNode : true) && // check we don't enter another block-like element
				(block ? blockIsStartNode : true); // check we don't enter nested blocks (special list case since it's not considered a limit)

			// If it's not a rootBlock text node, check to see if we hit a nested block element
			// or another element that logically should cause a word break

			if (!condition) {
				if (node.type == CKEDITOR.NODE_ELEMENT &&
					((blockLimit && !blockLimitIsStartNode) ||
					(block && !blockIsStartNode) ||
					node.is('br', 'sup', 'sub'))) {

					ww.hitWordBreak = true;
				}
			}

			return condition;
		}

		ww.walkerEvaluator = isRootBlockTextNode;
		ww.walkerGuard = isBookmark;

		var wordSeparatorRegex = /[.,"?!;: \u0085\u00a0\u1680\u280e\u2028\u2029\u202f\u205f\u3000]/;

		ww.isWordSeparator = function (character) {
			if (!character)
				return true;
			var code = character.charCodeAt(0);
			return ( code >= 9 && code <= 0xd ) || ( code >= 0x2000 && code <= 0x200a ) || wordSeparatorRegex.test(character);
		};

		ww.initializeNodeWalker();

		// special case where we immediately hit a bookmark.
		if (ww.lastBookmark) {
			range.moveToClosestEditablePosition(ww.lastBookmark, true);
			ww.lastBookmark = null;
			ww.initializeNodeWalker(range);
		}
	}

	WordWalker.prototype = {
		getOffsetToNextNonSeparator: function (text, startIndex) {
			var i, length;
			length = text.length;
			var ww = this;

			for (i = startIndex + 1; i < length; i++) {
				if (!ww.isWordSeparator(text[i])) {
					break;
				}
			}

			return i;

		},
		getOffsetToNextSeparator: function (text, startIndex) {
			var i, length;
			length = text.length;
			var ww = this;

			for (i = startIndex + 1; i < length; i++) {
				if (ww.isWordSeparator(text[i])) {
					break;
				}
			}

			return i;

		},
		initializeNodeWalker: function(lastRangeFound) {
			// determine what the new range should be
			var ww = this;
			var newRange = ww.origRange.clone();
			var skipFirstWord = false;
			if (lastRangeFound) {
				skipFirstWord = true;
				newRange.setStart(lastRangeFound.endContainer, lastRangeFound.endOffset);
			}

			ww.rootBlockTextNodeWalker = new CKEDITOR.dom.walker(newRange);
			ww.rootBlockTextNodeWalker.evaluator = ww.walkerEvaluator;
			ww.rootBlockTextNodeWalker.guard = ww.walkerGuard;

			ww.textNode = ww.rootBlockTextNodeWalker.next();

			// when resuming a range after a bookmark,
			// we need to skip any leftover pieces of the word
			// (if the bookmark was in the middle of a word)
			// and move to the next word (if there are multiple spaces in between)

			if (ww.textNode && skipFirstWord) {
				if (ww.hitWordBreak) {
					// we hit a word breaking element (br) immediately after resuming
					ww.hitWordBreak = false;
					ww.offset = 0;
				}
				else if (ww.isWordSeparator(ww.textNode.getText()[0])) {
					// We are on the text node immediately after a bookmark.
					// This text node starts with a space-like character
					// so just start on the next non-space
					ww.offset = ww.getOffsetToNextNonSeparator(ww.textNode.getText(), 0);
				}
				else {
					// We are on the text node immediately after a bookmark.
					// The bookmark is immediately followed by text
					// we should skip that text (since we skip the word the marker is on)
					// And instead start on the next word after the next space-like character.
					var nextSpace = ww.getOffsetToNextSeparator(ww.textNode.getText(), 0);
					ww.offset = ww.getOffsetToNextNonSeparator(ww.textNode.getText(), nextSpace);
				}
			}
		},
		normalizeWord: function (word) {
			// hex 200b = 8203 = zerowidth space
			return word.replace(/\u200B/g, '');
		},
		getNextWord: function () {
			var ww = this;

			// iterate through each of the text nodes in the walker
			// break, store current offset, and return a range when finding a word separator
			// until all text nodes in the walker are exhausted.

			var word = '';
			var currentTextNode = ww.textNode;
			var wordRange = ww.origRange.clone();
			var i;
			var text;

			if (currentTextNode === null) {
				return null;
			}

			wordRange.setStart(currentTextNode, ww.offset);

			while (currentTextNode !== null) {
				// this if block returns the word and range if we still have valid
				// text nodes but we traversed an element that should cause a word break
				if (text && i === text.length && ww.hitWordBreak) {
					ww.hitWordBreak = false;
					return {word: word, range: wordRange};
				}
				text = currentTextNode.getText();
				for (i = ww.offset; i < text.length; i++) {
					if (ww.isWordSeparator(text[i])) {
						word += text.substr(ww.offset, i - ww.offset);
						wordRange.setEnd(currentTextNode, i);

						ww.offset = ww.getOffsetToNextNonSeparator(text, i);
						if (word) {
							// if you hit a word separator and there is word text, return it
							return {word: ww.normalizeWord(word), range: wordRange};
						}
						else {
							// if the word is blank, set the start of the range to the next
							// non-separator text
							wordRange.setStart(currentTextNode, ww.offset);

							word = '';
						}
					}
				}

				word += text.substr(ww.offset);
				ww.offset = 0;
				wordRange.setEnd(currentTextNode, i);
				currentTextNode = ww.rootBlockTextNodeWalker.next();

				ww.textNode = currentTextNode;
			}
			// we either exhausted the block or hit our bookmark

			if (ww.lastBookmark) {
				// We stopped due to hitting a bookmark.
				// Initialize an additional node walker at the range following the bookmark.
				wordRange.moveToClosestEditablePosition(ww.lastBookmark, true);
				ww.initializeNodeWalker(wordRange);
				ww.lastBookmark = null;
				return ww.getNextWord();
			}
			else if (word) {
				// this is the remnants of the word
				return {
					word: ww.normalizeWord(word),
					range: wordRange
				};
			}
		}
	};

	function SuggestionsStorage() {
		this.enabled = false;

		//
		if (typeof store !== "undefined") {
			if (store.enabled) {
				this.enabled = true;
				this.addPersonal = this.addPersonalStoreJs;
				this.hasPersonal = this.hasPersonalStoreJs;
			}
			// if store is not undefined, but store is disabled
			// we don't want to proceed to the localStorage case,
			// since store will have already done this detection for us
		} else if (localStorage) { // localStorage can be disabled entirely (localStorage === null)
			// localStorage can also just throw exceptions due to a security policy
			try {
				localStorage.getItem('test');
				this.enabled = true;
				this.addPersonal = this.addPersonalLocalStorage;
				this.hasPersonal = this.hasPersonalLocalStorage;
			} catch (exception) {
			}
		}
	}

	SuggestionsStorage.prototype = {
		addPersonalLocalStorage: function (word) {
			// original nanospell code
			var value = localStorage.getItem('nano_spellchecker_personal');
			if (value) {
				value += String.fromCharCode(127);
			} else {
				value = "";
			}
			value += word.toLowerCase();
			localStorage.setItem('nano_spellchecker_personal', value);
		},
		addPersonalStoreJs: function (word) {
			var suggestions = store.get('nanospell_suggestions') || [];

			if (suggestions.indexOf(word) !== -1) return;

			suggestions.push(word);
			store.set('nanospell_suggestions', suggestions);
		},
		hasPersonalLocalStorage: function (word) {
			var value = localStorage.getItem('nano_spellchecker_personal');
			if (value === null || value == "") {
				return false;
			}
			var records = value.split(String.fromCharCode(127));
			word = word.toLowerCase();
			for (var i = 0; i < records.length; i++) {
				if (records[i] === word) {
					return true;
				}
			}
			return false;
		},
		hasPersonalStoreJs: function (word) {
			var suggestions = store.get('nanospell_suggestions') || [];
			return (suggestions.indexOf(word) !== -1);
		}

	};

	CKEDITOR.plugins.add('nanospell', {
		icons: 'nanospell',
		init: function (editor) {
			var self = this;

			// store the current timer
			this._timer = null;

			this.addRule(editor);
			overrideCheckDirty();

			if (editor && !editor.config.nanospell) {
				editor.config.nanospell = {};
			}
			this.settings = editor.config.nanospell;
			if (!this.settings) {
				this.settings = {};
			}
			lang = this.settings.dictionary || lang;
			this.suggestions = new SuggestionsStorage();
			// set the maximum number of block elements spellchecked per AJAX request
			self.settings.wordLimitPerRequest = self.settings.wordLimitPerRequest || DEFAULT_WORD_LIMIT_PER_REQUEST;
			editor.addCommand('nanospell', {
				exec: function (editor) {
					if (!commandIsActive) {
						start();
					} else {
						stop();
					}
				},
				editorFocus: true
			});
			editor.addCommand('nanospellReset', {
				exec: function (editor) {
					spellcache = [];
					suggestionscache = [];
					ignorecache = [];
					if (commandIsActive) {
						stop();
						start();
					}
				},
				editorFocus: true
			});
			editor.ui.addButton('nanospell', {
				label: 'Spell Checking by Nanospell',
				command: 'nanospell',
				toolbar: 'nanospell',
				icon: this.path + 'icons/nanospell.png'
			});
			editor.ui.addButton('Nanospell', {
				label: 'Spell Checking by Nanospell',
				command: 'nanospell',
				toolbar: 'Nanospell',
				icon: this.path + 'icons/nanospell.png'
			});
			editor.on("key", function (k) {
				if (k.data.domEvent.$.ctrlKey || k.data.domEvent.$.metaKey) {
					// a bizarre IE11 bug occurs if you attempt to get the
					// current element after undoing a recently spellchecked word
					return;
				}
				keyHandler(k.data.keyCode)
			});
			editor.on("focus", function () {
				editorHasFocus = true;
			});
			editor.on("blur", function () {
				editorHasFocus = false;
			});
			editor.on("instanceReady", function () {
				if (self.settings.autostart !== false) {
					start()
				}
			});
			editor.on('mode', function () {
				if (editor.mode == 'wysiwyg' && commandIsActive) {
					start()
				}
				return true;
			});
			editor.on(EVENT_NAMES.START_RENDER, scheduleRender, self);
			editor.on(EVENT_NAMES.START_SCAN_WORDS, scheduleScanWords, self);
			editor.on(EVENT_NAMES.START_CHECK_WORDS, checkWords, self);

			setUpContextMenu(editor, this.path);


			function setUpContextMenu(editor, path) {
				var iconpath = path + 'icons/nanospell.png';
				if (!editor.contextMenu) {
					setTimeout(function () {
						setUpContextMenu(editor, path)
					}, 100);
					return;
				}
				var generateSuggestionMenuItem = function (suggestion, icon, typo, element) {
					return {
						label: suggestion,
						icon: icon ? iconpath : null,
						group: 'nano',
						onClick: function () {
							if (suggestion.indexOf(String.fromCharCode(160)) > -1) {
								return window.open('http://ckeditor-spellcheck.nanospell.com/license?discount=developer_max');
							}

							element.setText(suggestion);
							// remove the wrapping span
							element.remove(true);
						}
					}
				};
				var currentTypoText = function () {
					var anchor = editor.getSelection().getStartElement();
					var range = editor.createRange();
					//Fixes FF and IE hilighting of selected word
					range.selectNodeContents(anchor);
					range.enlarge();
					range.optimize();
					range.select();
					// end fix
					return anchor.getText();
				};

				editor.addMenuGroup('nano', -10 * 3);
				/*at the top*/
				editor.addMenuGroup('nanotools', -10 * 3 + 1);
				editor.contextMenu.addListener(function (element) {
					if (!element.$ || !element.$.className || element.$.nodeName.toLowerCase() != 'span' || element.$.className !== "nanospell-typo") {
						return;
					}
					var typo = currentTypoText();
					var retobj = {};
					var suggestions = getSuggestions(typo);
					if (!suggestions) {
						return;
					}
					if (suggestions.length == 0) {

						editor.addMenuItem('nanopell_nosug', {
							label: locale.nosuggestions,
							icon: iconpath,
							group: 'nano'
						});
						retobj["nanopell_nosug"] = CKEDITOR.TRISTATE_DISABLED
					} else {
						for (var i = 0; i < suggestions.length; i++) {
							var word = suggestions[i];
							if (word.replace(/^\s+|\s+$/g, '').length < 1) {
								continue;
							}
							editor.addMenuItem('nanopell_sug_' + i, generateSuggestionMenuItem(word, !i, typo, element));
							retobj["nanopell_sug_" + i] = CKEDITOR.TRISTATE_OFF;
						}
					}

					editor.addMenuItem('nanopell_ignore', {
						label: locale.ignore,
						group: 'nanotools',
						onClick: function () {
							ignoreWord(element.$, typo, true);
						}
					});

					retobj["nanopell_ignore"] = CKEDITOR.TRISTATE_OFF;
					//
					if (self.suggestions.enabled) {
						editor.addMenuItem('nanopell_learn', {
							label: locale.learn,
							group: 'nanotools',
							onClick: function () {
								self.addPersonal(typo);
								ignoreWord(element.$, typo, true);
							}
						});
						retobj["nanopell_learn"] = CKEDITOR.TRISTATE_OFF;
					}
					return retobj
				});

				appendCustomStyles(self.path);
			}

			/* #2 setup layer */
			/* #3 nanospell util layer */
			function start() {
				editor.getCommand('nanospell').setState(CKEDITOR.TRISTATE_ON);
				commandIsActive = true;

				startSpellCheckTimer(DEFAULT_DELAY, null);
			}

			function stop() {
				editor.getCommand('nanospell').setState(CKEDITOR.TRISTATE_OFF);
				commandIsActive = false;

				// clear any currently queued spellcheck

				if (self._timer) {
					clearTimeout(self._timer);
					self._timer = null;
				}
				self.clearAllSpellCheckingSpans(editor.editable());
			}

			function checkNow(rootElement) {
				rootElement = rootElement || editor.editable();

				if (!selectionCollapsed() || spellCheckInProgress(rootElement)) {
					self._timer = null;
					startSpellCheckTimer(DEFAULT_DELAY, rootElement);
					editor.fire(EVENT_NAMES.SPELLCHECK_ABORT, rootElement);
					return;
				}
				if (commandIsActive) {

					editor.fire(EVENT_NAMES.START_SCAN_WORDS, rootElement);
				}
			}

			function scheduleScanWords(event) {
				setTimeout(scanWords, 0, event);
			}

			function scanWords(event) {
				var rootElement = event.data,
					range = editor.createRange();

				range.selectNodeContents(rootElement);
				scanWordsInRange(range);
			}

			function elementAtCursor() {
				if (!editor.getSelection()) {
					return null;
				}
				return editor.getSelection().getStartElement();
			}

			function keyHandler(ch8r) {
				editorHasFocus = true;
				//recheck after typing activity
				if (ch8r >= 16 && ch8r <= 31) {
					return;
				}
				if (ch8r >= 37 && ch8r <= 40) {
					return;
				}
				var target = elementAtCursor();
				if (!target) {
					return;
				}

				var elementPath = new CKEDITOR.dom.elementPath(target);
				var selection = editor.getSelection();
				var range = selection.getRanges()[0];

				//if! user is typing on a typo remove its underline

				var spellCheckSpan = elementPath.contains(isSpellCheckSpan);

				if (!spellCheckSpan) {
					// if we are not directly inside a span, we can still be touching the edge
					if (isSpellCheckSpan(range.getTouchedStartNode())) {
						spellCheckSpan = range.getTouchedStartNode();
					}
					else if (isSpellCheckSpan(range.getTouchedEndNode())) {
						spellCheckSpan = range.getTouchedEndNode();
					}
				} else {
					// somehow our spellcheck block was a span, so we need to get the parent instead.
					target = findNearestParentBlock(target);
				}

				if (spellCheckSpan) {
					editor.lockSelection();
					var bookmarks = editor.getSelection().createBookmarks(true);
					self.unwrapTypoSpan(spellCheckSpan);
					editor.unlockSelection();
					editor.getSelection().selectBookmarks(bookmarks);
				}

				triggerSpelling((spellFastAfterSpacebar && (ch8r === CHARCODES.SPACE || ch8r === CHARCODES.LF || ch8r === CHARCODES.CR)), target)
			}

			function findNearestParentBlock(element) {
				var elementPath = new CKEDITOR.dom.elementPath(element),
					elements = elementPath.elements;

				for (var i = 0; i < elements.length; i++) {
					var name = elements[i].getName();
					if (CKEDITOR.dtd.$block[name]) {
						return elements[i];
					}
				}
			}

			function isSpellCheckSpan(node) {
				return node.type === CKEDITOR.NODE_ELEMENT && node.getName() === 'span' && node.hasClass('nanospell-typo');
			}

			function checkWords(event) {
				var words = event.data.words;
				var blockList = event.data.blockList;
				var url = resolveAjaxHandler();
				var callback = function (data) {
					var rootElement;
					parseRpc(data, words);

					for (var i = 0; i < blockList.length; i++) {
						rootElement = blockList[i];
						editor.fire(EVENT_NAMES.START_RENDER, {
							root: rootElement,
						});
					}
				};
				var data = wordsToRPC(words, lang);
				rpc(url, data, callback);
			}

			function wordsToRPC(words, lang) {
				return '{"id":"c0","method":"spellcheck","params":{"lang":"' + lang + '","words":["' + words.join('","') + '"]}}'
			}

			function rpc(url, data, callback) {
				var xhr = new XMLHttpRequest();
				if (!xhr) {
					return null;
				}
				xhr.open('POST', url, true);
				xhr.onreadystatechange = function () {
					if ((xhr.readyState == 4 && ((xhr.status >= 200 && xhr.status < 300) || xhr.status == 304 || xhr.status === 0 || xhr.status == 1223))) {

						callback(xhr.responseText);
						xhr = null;
					}
				};
				xhr.send(data);
				return true;
			}

			function parseRpc(data, words) {
				try {
					var json = JSON.parse(data);
				} catch (e) {

					var msg = ("Nanospell need to be installed correctly before use (server:" + this.settings.server + ").\n\nPlease run nanospell/getstarted.html. ");

					if (window.location.href.indexOf('nanospell/') < 0) {
						console.log(msg)
					} else {
						if (confirm(msg)) {
							window.location = self.path + "../getstarted.html"
						}
					}
				}

				var result = json.result;
				for (var i in words) {
					var word = words[i];
					if (result[word]) {
						suggestionscache[word] = result[word];
						spellcache[word] = false;
					} else {
						spellcache[word] = true;
					}
				}
			}

			function resolveAjaxHandler() {
				return (window.ROOT_URL_PATH ? window.ROOT_URL_PATH : '') + '/spellcheck/nano/';
			}

			function scheduleRender(event) {
				setTimeout(render, 0, event);
			}

			function render(event) {
				var rootElement = event.data.root,
					selectionStart = editor.getSelection().getStartElement(),
					needsBookmarkCreated,
					bookmarks;

				needsBookmarkCreated = selectionStart ? rootElement.contains(selectionStart) || rootElement.equals(selectionStart) : null;

				if (needsBookmarkCreated) {
					editor.lockSelection();
					bookmarks = editor.getSelection().createBookmarks(true);
				}

				self.markTypos(editor, rootElement);

				if (needsBookmarkCreated) {
					editor.getSelection().selectBookmarks(bookmarks);
					editor.unlockSelection();
				}

				rootElement.setCustomData('spellCheckInProgress', false);
				self._timer = null;
				editor.fire(EVENT_NAMES.SPELLCHECK_COMPLETE);
			}

			function appendCustomStyles(path) {
				CKEDITOR.document.appendStyleSheet(path + "theme/nanospell.css");
			}

			var __memtok = null;
			var __memtoks = null;

			function wordTokenizer(singleton) {
				if (!singleton && !!__memtok) {
					return __memtok
				}
				if (singleton && !!__memtoks) {
					return __memtoks
				}
				var email = "\\b[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,4}\\b";
				var protocol = "\\bhttp[s]?://[a-z0-9#\\._/]{5,}\\b";
				var domain = "\\bwww\.[a-z0-9#\._/]{8,128}[a-z0-9/]\\b";
				var invalidchar = "\\s!\"#$%&()*+,-.â€¦/:;<=>?@[\\]^_{|}`\u200b\u00a7\u00a9\u00ab\u00ae\u00b1\u00b6\u00b7\u00b8\u00bb\u00bc\u00bd\u00be\u00bf\u00d7\u00f7\u00a4\u201d\u201c\u201e\u201f" + String.fromCharCode(160);
				var validword = "[^" + invalidchar + "'\u2018\u2019][^" + invalidchar + "]+[^" + invalidchar + "'\u2018\u2019]";
				var result = new RegExp("(" + email + ")|(" + protocol + ")|(" + domain + ")|(&#\d+;)|(" + validword + ")", singleton ? "" : "g");

				if (singleton) {
					__memtoks = result
				} else {
					__memtok = result
				}
				return result;
			}

			/*
			 Given some text, get the unique words in it that we don't have a spellcheck status for
			 */
			function getUnknownWords(text) {
				var matches = text.match(wordTokenizer());
				var uniqueWords = [];
				var words = [];
				if (!matches) {
					return words;
				}
				for (var i = 0; i < matches.length; i++) {
					var word = normalizeQuotes(matches[i]);
					if (!uniqueWords[word] && self.validWordToken(word) && (typeof(spellcache[word]) === 'undefined')) {
						words.push(word);
						uniqueWords[word] = true;
						spellcache[word] = true; // mark the word as correct, when the RPC returns, it will set this properly.
					}
				}
				return words;
			}

			/*
			 for a given range, get the unique words in it that we don't have a spellcheck status for
			 */
			function scanWordsInRange(range) {
				var combinedWords = [],
					block,
					blockList = [],
					iterator = range.createIterator();
				while (( block = iterator.getNextParagraph() )) {
					block.setCustomData('spellCheckInProgress', true);
					combinedWords = combinedWords.concat(getWords(block));
					blockList.push(block);
					if (combinedWords.length >= self.settings.wordLimitPerRequest) {
						startCheckOrMarkWords(getUnknownWords(combinedWords.join(' ')), blockList);
						combinedWords = [];
						blockList = [];
					}
				}

				if (blockList.length > 0) {
					startCheckOrMarkWords(getUnknownWords(combinedWords.join(' ')), blockList);
				}

			}

			function getWords(block) {
				var range = editor.createRange(),
					currentWordObj,
					words = [],
					word;

				range.selectNodeContents(block);

				var wordwalker = new self.WordWalker(editor, range);

				while (currentWordObj = wordwalker.getNextWord()) {
					word = currentWordObj.word;
					if (word) words.push(word);
				}

				return words;
			}

			function startCheckOrMarkWords(words, blockList) {
				if (words.length > 0) {
					editor.fire(EVENT_NAMES.START_CHECK_WORDS, {
						words: words,
						blockList: blockList
					});
				}
				else {
					for (var i = 0; i < blockList.length; i++) {
						var rootElement = blockList[i];

						editor.fire(
							EVENT_NAMES.START_RENDER,
							{
								root: rootElement,
							});

					}
				}
			}

			function spellCheckInProgress(element) {
				var elementPath = new CKEDITOR.dom.elementPath(element);

				return elementPath.contains(function (el) {
					return (el.getCustomData('spellCheckInProgress') === true)
				})
			}

			function getSuggestions(word) {
				word = normalizeQuotes(word);
				if (suggestionscache[word] && suggestionscache[word][0]) {
					if (suggestionscache[word][0].indexOf("*") == 0) {
						return ["nanospell\xA0plugin\xA0developer\xA0trial ", "ckeditor-spellcheck.nanospell.com/license\xA0"];
					}
				}
				return suggestionscache[word];
			}

			function selectionCollapsed() {
				if (!editor.getSelection()) {
					return true;
				}
				return editor.getSelection().getSelectedText().length == 0;
			}

			function startSpellCheckTimer(delay, rootElement) {
				if (self._timer !== null) {
				} else {
					self._timer = setTimeout(checkNow, delay, rootElement);
				}
			}

			function triggerSpelling(immediate, target) {
				//only recheck when the user pauses typing
				if (selectionCollapsed()) {
					startSpellCheckTimer(immediate ? DEFAULT_DELAY : spellDelay, target);
				}
			}

			function ignoreWord(target, word, all) {
				var allInstances,
					i,
					numInstances;
				if (all) {
					ignorecache[word.toLowerCase()] = true;
					for (i in suggestionscache) {
						if (i.toLowerCase() == word.toLowerCase()) {
							delete suggestionscache[i];
						}
					}
					allInstances = editor.document.find('span.nanospell-typo');
					numInstances = allInstances.count();
					for (i = 0; i < numInstances; i++) {
						var item = allInstances.getItem(i);
						var text = item.getText();
						if (text == word) {
							item.remove(true);
						}
					}
				} else {
					target.remove(true);
				}
			}

			function overrideCheckDirty() {

				var editorCheckDirty = CKEDITOR.editor.prototype;

				editorCheckDirty.checkDirty = CKEDITOR.tools.override(editorCheckDirty.checkDirty, function (org) {

					return function () {
						var retval = (this.status == 'ready');

						if (retval) {
							var currentData = self.clearAllSpellCheckingSpansFromString(this.getSnapshot()),
								prevData = this._.previousValue;

							retval = (retval && (prevData !== currentData))
						}

						return retval;
					};
				});

				editorCheckDirty.resetDirty = CKEDITOR.tools.override(editorCheckDirty.resetDirty, function (org) {
					return function () {
						this._.previousValue = self.clearAllSpellCheckingSpansFromString(this.getSnapshot());
					};
				});
			}


		},
		unwrapTypoSpan: function(span) {
			span.remove(true);
		},
		clearAllSpellCheckingSpans: function (element) {
			var spans = element.find('span.nanospell-typo');

			for (var i = 0; i < spans.count(); i++) {
				var span = spans.getItem(i);
				this.unwrapTypoSpan(span);
			}
		},
		clearAllSpellCheckingSpansFromString: function (htmlString) {
			var element = new CKEDITOR.dom.element('div');
			element.setHtml(htmlString);
			this.clearAllSpellCheckingSpans(element);
			return element.getHtml();
		},
		addRule: function (editor) {
			var dataProcessor = editor.dataProcessor,
				htmlFilter = dataProcessor && dataProcessor.htmlFilter,
				pathFilters = editor._.elementsPath && editor._.elementsPath.filters,
				dataFilter = dataProcessor && dataProcessor.dataFilter,
				removeFormatFilter = editor.addRemoveFormatFilter,
				pathFilter = function (element) {
					if (element.hasClass('nanospell-typo')) {
						return false;
					}
				},
				removeFormatFilterTemplate = function (element) {
					var result = true;

					if (element.hasClass('nanospell-typo')) {
						result = false;
					}

					return result;
				};

			if (pathFilters) {
				pathFilters.push(pathFilter);
			}

			if (dataFilter) {
				var dataFilterRules = {
					elements: {
						span: function (element) {

							var scaytState = element.hasClass('nanospell-typo');

							if (scaytState) {
								delete element.name;
							}

							return element;
						}
					}
				};

				dataFilter.addRules(dataFilterRules);
			}

			if (htmlFilter) {
				var htmlFilterRules = {
					elements: {
						span: function (element) {

							var scaytState = element.hasClass('nanospell-typo');

							if (scaytState) {
								delete element.name;
							}

							return element;
						}
					}
				};

				htmlFilter.addRules(htmlFilterRules);
			}

			if (removeFormatFilter) {
				removeFormatFilter.call(editor, removeFormatFilterTemplate);
			}
		},
		addPersonal: function (word) {
			if (this.suggestions.enabled) {
				return this.suggestions.addPersonal(word);
			}
		},
		hasPersonal: function (word) {
			if (this.suggestions.enabled) {
				return this.suggestions.hasPersonal(word);
			}
			return false;
		},
		validWordToken: function (word) {
			if (!word) {
				return false;
			}
			if (/\s/.test(word)) {
				return false;
			}
			if (/[:\.@\/\\]/.test(word)) {
				return false;
			}
			if (/^\d+$/.test(word) || word.length == 1) {
				return false;
			}
			var ingnoreAllCaps = (this.settings.ignore_block_caps === true);
			var ignoreNumeric = (this.settings.ignore_non_alpha !== false);
			if (ingnoreAllCaps && word.toUpperCase() == word) {
				return false;
			}
			if (ignoreNumeric && /\d/.test(word)) {
				return false;
			}
			if (ignorecache[word.toLowerCase()]) {
				return false;
			}
			return !this.hasPersonal(word);
		},
		rangeIsFullyMarked: function (range) {
			var startContainer, endContainer;
			range.optimize();

			startContainer = range.startContainer;
			endContainer = range.endContainer;

			if (startContainer.type === CKEDITOR.NODE_ELEMENT && startContainer.getName() === 'span' && startContainer.hasClass('nanospell-typo') && startContainer.equals(endContainer)) {
				return true;
			}
			return false;
		},
		wrapWithTypoSpan: function (editor, range) {
			var span;

			// if the range is entirely a typo span already, we can abort

			if (this.rangeIsFullyMarked(range)) {
				return;
			}

			span = editor.document.createElement(
				'span',
				{
					attributes: {
						'class': 'nanospell-typo'
					}
				}
			);

			var extracted = range.extractContents();
			extracted.appendTo(span);
			// clear any leftover spans which may be left behind from merging words
			this.clearAllSpellCheckingSpans(span);
			range.insertNode(span);
		},
		markTypos: function (editor, node) {
			var range = editor.createRange();
			range.selectNodeContents(node);

			this.markTyposInRange(editor, range);
		},
		markTyposInRange: function (editor, range) {
			var match;
			var wordwalker = new this.WordWalker(editor, range);
			var badRanges = [];
			var matchtext;

			while ((match = wordwalker.getNextWord()) != null) {
				matchtext = match.word;

				if (!this.validWordToken(matchtext)) {
					continue;
				}
				if (typeof(suggestionscache[normalizeQuotes(matchtext)]) !== 'object') {
					continue;
				}
				badRanges.push(match.range)
			}

			var rangeListIterator = (new CKEDITOR.dom.rangeList(badRanges)).createIterator();
			var currRange;

			while (currRange = rangeListIterator.getNextRange()) {
				this.wrapWithTypoSpan(editor, currRange);
			}
		},
		WordWalker: WordWalker,
		SuggestionsStorage: SuggestionsStorage
	});

})();
