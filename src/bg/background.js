///<reference path="../../../sfdb.js/src/Dexie.js" />

!function (window, $, undefined) {

    var     exactMatchHTML = "<div class='exact-match-tag rotate-left'>\
                            <div class='exact-match-bottom'>\
                                <div class='exact-match-text'>\
                                Exact Match\
                                </div>\
                            </div>\
                            <div class='exact-match-top'>\
                            </div>\
                            <i class='icon icon-pushpin'></i>\
                         </div>"
        ,   isActive = {}
        ,   deleteDone = true
        //,   dbVersion = 2  // With Dexie, better to specify where its schema is defined (so that newer versions can be easily added)
        ,   settingsVersion = 1

    var db = new Dexie("AllMyHistory");

    // IDB version 2 corresponds to Dexie versino 0.2 (divide by 10)
    db.version(0.2).stores({
        links: "++id,date,*tags",
        settings: "v,*tags"
    });

    db.on('populate', function () {
        db.settings.put(
            {
                v: settingsVersion,
                // todo:
                // copy tags from previous version of the settings object (no such for now)
                tags: []
            }
        );
    });

    db.on('error',function (err) {
        var isCase = {
            "ConstraintError": function () {
                console.log("ConstraintError")
            }
        }
        if (isCase[err.name]) {
            isCase[err.name]()
        } else {
            console.log(err.message)
        }
    });

    db.open();


    chrome.runtime.onMessage.addListener(function (msg, sender, respond) {

        if (msg.from === "history") {

            if (msg.action === "inactive") {
                delete isActive[sender.tab.id]
                respond()
            }

            if (msg.action === "active") {
                isActive[sender.tab.id] = true
                respond()
            }

            if (msg.action === "showAll") {
                showAll(sender.tab.id, function(r) {
                     respond(r)
                })
            }

            if (msg.action === "search") {
                search(msg.tags, msg.text, msg.multi, sender.tab.id, function(r) {
                    respond(r)
                })
            }

            if (msg.action === "getHostTags") {

                db.settings.get(settingsVersion, respond);

            }

            if (msg.action === "saveHostTags") {

                db.settings.put(
                    {
                        v: settingsVersion,
                        tags: NLP.unique(msg.tags)
                    }
                )

                // close the handler
                respond()
            }
        }

        if (msg.from === "content") {

            if (msg.action == "allow") {

                var test = false;

                db.settings.get(settingsVersion, function (result) {

                    var hostname = msg.hostname

                    var tags = result.tags

                    for (var n = 0, len = tags.length; n < len; n++) {
                     if (hostname.match(new RegExp("([^a-zA-Z0-9\\-]|^)" + esc(tags[n]) + "(?![a-zA-Z0-9\\-])"))) {
                           test = true
                           break
                       }
                    }

                    if (test) {
                       respond(false)
                    } else {
                       respond(true)
                    }
                });
            }

            if (msg.action === "store") {
                var     url = sender.tab.url
                    ,   text = msg.text
                    ,   tags = msg.tags
                    ,   date = msg.date
                    ,   title = msg.title

                // async control loop, start by capturing sender.tab and the listener's respond function
                !function(tab, respond) {

                    // timeout is needed here because bug in Chrome that causes capture API to fail
                    // if fired immediately upon tab becoming visible
                    function captureActive() {

                        // is the tab we're after is active right at this precise time?
                        chrome.tabs.query({active: true, currentWindow: true}, function (tabs) {

                            // if not, and another tab is active right now, re-send capture request to tab and return
                            // The tab will respond when it's visible
                            if (!tabs[0] || tab.id !== tabs[0].id) {
                                // close the handler
                                respond()
                                // retry capture
                                capture(tab.id)
                                return
                            }

                            // tell the tab that we got it
                            respond(true)

                            // when the tab that invoked this function is active (visible at this precise time)
                            chrome.tabs.captureVisibleTab(
                                chrome.windows.WINDOW_ID_CURRENT, {format: "png"},
                                function (src) {
                                    if (!src) {
                                        return
                                    }

                                    db.links.add(
                                        {
                                            date: new Date().toLocaleString(),
                                            title: title,
                                            tags: tags,
                                            text: text,
                                            url: url,
                                            img: src
                                        }
                                    ).then(function () {

                                        // see if we need to free up disk space
                                        console.log(url);
                                        console.log(text);
                                        console.log(tags.sort());

                                        var total = 10000

                                        function freeSpace() {

                                            if (!deleteDone) return

                                            deleteDone = false

                                            db.links.count(function (numItems) {

                                                // if ~> 5Gb, assuming a generous 500K per page
                                                if (numItems > total) {

                                                    console.log('freeing up space... very lazily')

                                                    db.links.orderBy("id").limit(numItems / 10 >> 0).delete().finally(function () {

                                                        deleteDone = true;

                                                    });
                                                } else {
                                                    deleteDone = true;
                                                }

                                            });

                                        }

                                        freeSpace()
                                    })
                                }
                            )

                        })
                    }
                    setTimeout(captureActive, 500)
                }(sender.tab, respond)
            }
        }

        // keeps the handler running (ref: Chrome API docs)
        return true
    });

    chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
        if (changeInfo.status === "complete") {
            capture(tabId)
        }
    })

    chrome.tabs.onReplaced.addListener(function(tabId, removedTabId){
        delete isActive[removedTabId]
        capture(tabId)
    });

    chrome.tabs.onRemoved.addListener(function (tabId, removeInfo) {
        delete isActive[tabId]
    })

    function esc(str) {
        return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
    }

    function capture(tabId, retry) {

        chrome.tabs.executeScript(tabId, {file: "vendor/jquery-2.1.0.min.js", runAt: "document_start"}, function (result) {
            if (chrome.runtime.lastError) {
                return;
            }
        })
        chrome.tabs.executeScript(tabId, {file: "src/lib/nlp.js", runAt: "document_start"}, function (result) {
            if (chrome.runtime.lastError) {
                return;
            }
        })

        chrome.tabs.executeScript(tabId, {file: "src/inject/addHistoryItem.js", runAt: "document_start"}, function (result) {
            if (chrome.runtime.lastError) {
                return;
            }
        })
    }

    function showAll(tabId, cb) {

        function tabInactivated() {
            return !isActive[tabId];
        }

        var found = false;

        db.links.orderBy('id').reverse().until(tabInactivated).each(function (link) {

            chrome.tabs.sendMessage(tabId,
                {
                    from: "bg",
                    action: "append",
                    data: {
                        title: link.title,
                        date: link.date,
                        img: link.img,
                        url: link.url
                    }
                }
            )

            found = true; // There was a bug here that called cb() on each iteration. Now cb is called in then() to be called only once. /David.

        }).then(function () { cb(found) }); 
    }


    function search(tags, text, multi, tabId, cb) {

        function tabInactivated() {
            return !isActive[tabId];
        }

        var anythingFound = false;

        return db.links
            .where("tags").anyOf(tags) // Previous version only search for the last tag. I assume you want to search for any of given tags?
            .reverse()
            .until(tabInactivated)
            .each(function (link) {

                var found = false,
                    isExactMatch = false;

                var len = tags.length > 1 ? tags.length - 1 : 0;
                var _tags = link.tags

                while (len--) {
                    if (_tags.indexOf(tags[len]) === -1) {
                        found = false;
                        break;
                    }
                }

                if (found) {
                    var exactTest = link.text.indexOf(text)
                    if (multi && exactTest !== -1) {
                        isExactMatch = true
                    }
                }

                if (found) {
                    chrome.tabs.sendMessage(tabId,
                        {
                            from: "bg",
                            action: isExactMatch ? "prepend" : "append",
                            data: {
                                title: link.title,
                                date: link.date,
                                exactMatch: isExactMatch ? exactMatchHTML : undefined,
                                img: link.img,
                                url: link.url
                            }
                        }
                    )

                    anythingFound = true;
                }

            }).then(function () {

                if (anythingFound)
                    return "found";
                else
                    return db.links.count(function (numLinks) {
                        return numLinks ? "not found" : "no items";
                    })

            }).then(function (result) {

                cb({ result: result });

            }).catch(function (err) {

                console.log(err.stack || err); // Will log the stack if existing

                cb({ result: "error" }); // TODO: Recieve error in history.js

            });
    }


    function dataURItoBlob(dataURI) {
        // convert base64 to raw binary data held in a string
        // doesn't handle URLEncoded DataURIs
        var byteString = atob(dataURI.split(',')[1]);

        // separate out the mime component
        var mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0]

        // write the bytes of the string to an ArrayBuffer
        var ab = new ArrayBuffer(byteString.length);
        var ia = new Uint8Array(ab);
        for (var i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i);
        }

        // write the ArrayBuffer to a blob
        var bb;
        if ( typeof BlobBuilder != 'undefined' )
            bb = new BlobBuilder();
        else
            bb = new WebKitBlobBuilder();
        bb.append(ab);
        return bb.getBlob(mimeString);
    }

}(window,jQuery)



