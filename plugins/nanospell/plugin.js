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

	var maxRequest = 200;
	var editorHasFocus = false;
	var spellDelay = 250;
	var spellFastAfterSpacebar = true;
	var state = false;
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

	function normalizeQuotes(word) {
		return word.replace(/[\u2018\u2019]/g, "'");
	}

	function WordWalker(range) {
		// the WordWalker takes a range encompassing a block element
		// (for example, p, li, td)
		// and provides a mechanism for iterating over each word within,
		// ignoring non-block elements.  (for example, span)
		var isNotBookmark = CKEDITOR.dom.walker.bookmark(false, true);
		var isBlockBoundary = CKEDITOR.dom.walker.blockBoundary();

		var startNode = range.startContainer;
		var endNode = range.endContainer;

		function isRootBlockTextNode(node) {
			// this function is an evaluator used to return only
			// the text nodes in the walker.
			// because of a special case around nested lists,
			// non-root block nodes must also be excluded.
			// the text content of ckeditor bookmarks must also be excluded
			// or &nbsp; will be added throughout.

			var path = new CKEDITOR.dom.elementPath(node, startNode);

			var condition = node.type == CKEDITOR.NODE_TEXT && // it is a text node
				node.getLength() > 0 &&  // and it's not empty
				( !node.isReadOnly() ) &&   // or read only
				isNotBookmark(node) && // and isn't a fake bookmarking node
				(path.blockLimit ? path.blockLimit.equals(startNode): true) &&
				(path.block ? path.block.equals(startNode): true);

			return condition;
		}

		function guard(node) {
			return isBlockBoundary(node) && !(node.equals(startNode));
		}

		this.rootBlockTextNodeWalker = new CKEDITOR.dom.walker(range);
		this.rootBlockTextNodeWalker.evaluator = isRootBlockTextNode;
		//this.rootBlockTextNodeWalker.guard = guard;

		var wordSeparatorRegex = /[.,"'?!;: \u0085\u00a0\u1680\u280e\u2028\u2029\u202f\u205f\u3000]/;

		this.isWordSeparator = function (character) {
			if (!character)
				return true;
			var code = character.charCodeAt(0);
			return ( code >= 9 && code <= 0xd ) || ( code >= 0x2000 && code <= 0x200a ) || wordSeparatorRegex.test(character);
		};

		this.textNode = this.rootBlockTextNodeWalker.next();
		this.offset = 0;
		this.origRange = range;
	}

	WordWalker.prototype = {
		getOffsetToNextNonSeparator: function (text, startIndex) {
			var i, length;
			length = text.length;

			for (i = startIndex + 1; i < length; i++) {
				if (!this.isWordSeparator(text[i])) {
					break;
				}
			}

			return i;

		},
		getNextWord: function () {

			// iterate through each of the text nodes in the walker
			// break, store current offset, and return a range when finding a word separator
			// until all text nodes in the walker are exhausted.

			var word = '';
			var currentTextNode = this.textNode;
			var wordRange = this.origRange.clone();
			var i;
			var text;

			if (currentTextNode === null) {
				return null;
			}

			wordRange.setStart(currentTextNode, this.offset);

			while (currentTextNode !== null) {
				text = currentTextNode.getText();
				for (i = this.offset; i < text.length; i++) {
					if (this.isWordSeparator(text[i])) {
						word += text.substr(this.offset, i - this.offset);
						wordRange.setEnd(currentTextNode, i);

						this.offset = this.getOffsetToNextNonSeparator(text, i);

						return {
							word: word,
							range: wordRange
						}
					}
				}
				word += text.substr(this.offset);
				this.offset = 0;
				wordRange.setEndAfter(this.textNode);
				currentTextNode = this.rootBlockTextNodeWalker.next();

				this.textNode = currentTextNode;

			}
			// reached the end of block,
			// so just return what we've walked
			// of the current word.

			return {
				word: word,
				range: wordRange
			};

		}
	};

	CKEDITOR.plugins.add('nanospell', {
		icons: 'nanospell',
		init: function (editor) {
			var self = this;

			// a lock to prevent multiple spellchecks
			this._isBusy = false;

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
			editor.addCommand('nanospell', {
				exec: function (editor) {
					if (!state) {
						start();
					} else {
						stop();
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
				if (editor.mode == 'wysiwyg' && state) {
					start()
				}
				return true;
			});

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
					if (localStorage) {
						editor.addMenuItem('nanopell_learn', {
							label: locale.learn,
							group: 'nanotools',
							onClick: function () {
								addPersonal(typo);
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
				state = true;

				startTimer(50);
			}

			function stop() {
				editor.getCommand('nanospell').setState(CKEDITOR.TRISTATE_OFF);
				state = false;
				clearAllSpellCheckingSpans(editor.editable());
			}

			function checkNow() {
				if (!selectionCollapsed() || self._isBusy) {
					return;
				}
				if (state) {

					self._isBusy = true;

					var words = getWords(editor.document.$.body, maxRequest);
					if (words.length == 0) {
						render();
					} else {
						send(words);
					}
				}
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

				//if! user is typing on a typo remove its underline

				var spellCheckSpan = elementPath.contains(isSpellCheckSpan);

				if (spellCheckSpan) {
					var bookmarks = editor.getSelection().createBookmarks();
					unwrapTypoSpan(spellCheckSpan);
					editor.getSelection().selectBookmarks(bookmarks);
				}

				triggerSpelling((spellFastAfterSpacebar && (ch8r === CHARCODES.SPACE || ch8r === CHARCODES.LF || ch8r === CHARCODES.CR)))
			}

			function isSpellCheckSpan(node) {
				return node.getName() === 'span' && node.hasClass('nanospell-typo');
			}

			function send(words) {
				var url = resolveAjaxHandler();
				var callback = function (data) {
					parseRpc(data, words);
					render();
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
				render();
			}

			function resolveAjaxHandler() {
				return '/spellcheck/nano/';
			}

			function render() {
				var bookmarks = editor.getSelection().createBookmarks();
				clearAllSpellCheckingSpans(editor.editable());
				self.markAllTypos(editor);
				editor.getSelection().selectBookmarks(bookmarks);

				editor.fire('SpellcheckStart');
				editor.nanospellstarted = true;
				self._isBusy = false;
				self._timer = 0;
			}

			function clearAllSpellCheckingSpans(element) {
				var spans = element.find('span.nanospell-typo');

				for (var i = 0; i < spans.count(); i++) {
					var span = spans.getItem(i);
					unwrapTypoSpan(span);
				}

			}

			function clearAllSpellCheckingSpansFromString(htmlString) {
				var element = new CKEDITOR.dom.element('div');
				element.setHtml(htmlString);
				clearAllSpellCheckingSpans(element);
				return element.getHtml();
			}

			function appendCustomStyles(path) {
				CKEDITOR.document.appendStyleSheet(path + "/theme/nanospell.css");
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

			function getWords(corpus, max) {
				var range = editor.createRange(),
					block,
					fullTextContext = '';

				range.selectNodeContents(editor.editable());

				var iterator = range.createIterator();
				while (( block = iterator.getNextParagraph() )) {
					fullTextContext += block.getText() + ' ';
				}

				var matches = fullTextContext.match(wordTokenizer());
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
						if (words.length >= max) {
							return words;
						}
					}
				}
				return words;
			}

			function addPersonal(word) {
				var value = localStorage.getItem('nano_spellchecker_personal');
				if (value !== null && value !== "") {
					value += String.fromCharCode(127);
				} else {
					value = "";
				}
				value += word.toLowerCase();
				localStorage.setItem('nano_spellchecker_personal', value);
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

			function unwrapTypoSpan(span) {

				span.remove(true);
			}

			function selectionCollapsed() {
				if (!editor.getSelection()) {
					return true;
				}
				return editor.getSelection().getSelectedText().length == 0;
			}

			function startTimer(delay) {
				if (self._timer) {
				} else {
					self._timer = setTimeout(checkNow, delay);
				}
			}

			function triggerSpelling(immediate) {
				//only recheck when the user pauses typing
				if (selectionCollapsed()) {
					startTimer(immediate ? 50 : spellDelay)
				}
			}

			function ignoreWord(target, word, all) {
				var i;
				if (all) {
					ignorecache[word.toLowerCase()] = true;
					for (i in suggestionscache) {
						if (i.toLowerCase() == word.toLowerCase()) {
							delete suggestionscache[i];
						}
					}
					var allInstances = editor.document.find('span.nanospell-typo');
					for (i = 0; i < allInstances.count(); i++) {
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
							var currentData = clearAllSpellCheckingSpansFromString(this.getSnapshot()),
								prevData = clearAllSpellCheckingSpansFromString(this._.previousValue);

							retval = (retval && (prevData !== currentData))
						}

						return retval;
					};
				});

				editorCheckDirty.resetDirty = CKEDITOR.tools.override(editorCheckDirty.resetDirty, function (org) {
					return function () {
						this._.previousValue = clearAllSpellCheckingSpansFromString(this.getSnapshot());
					};
				});
			}


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
		hasPersonal: function (word) {
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
		wrapWithTypoSpan: function (editor, range) {
			var span = editor.document.createElement(
				'span',
				{
					attributes: {
						'class': 'nanospell-typo'
					}
				}
			);
			range.extractContents().appendTo(span);
			range.insertNode(span);
		},
		markTypos: function (editor, node) {
			var range = editor.createRange();
			range.selectNodeContents(node);

			this.markTyposInRange(editor, range);
		},
		markTyposInRange: function (editor, range) {
			var match;

			var wordwalker = new this.WordWalker(range);

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
		markAllTypos: function (editor) {
			var range = editor.createRange(),
				block;

			range.selectNodeContents(editor.editable());

			var iterator = range.createIterator();
			while (( block = iterator.getNextParagraph() )) {
				this.markTypos(editor, block);
			}
		},
		WordWalker: WordWalker
	});

})();
