function listAllTabs() {
  let queryPinned = { pinned: true };
  let queryAll = { };

  console.log("----- pinned----");
  chrome.tabs.query(queryPinned).then( (tabs) => {
        for( const oneTab of tabs ) {
            console.log( "ID: " + oneTab.id + " [" + oneTab.title + "] pin:" + oneTab.pinned );
        }
  });

  console.log("----- ALL ----");
  chrome.tabs.query(queryAll).then( (tabs) => {
        for( const oneTab of tabs ) {
            console.log( "ID: " + oneTab.id + " [" + oneTab.title + "]  pin:" + oneTab.pinned );
        }
  });

  
}

console.log("Script V1, started");
listAllTabs();
