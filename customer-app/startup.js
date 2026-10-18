// Classic ES5 script: still runs when a browser cannot parse the main module.
(function () {
  var forms = ["login", "verify"];
  for (var i = 0; i < forms.length; i++) {
    var form = document.getElementById(forms[i]);
    if (form) form.addEventListener("submit", function (event) {
      if (!window.NDAHI_READY) event.preventDefault();
    });
  }
  setTimeout(function () {
    var help = document.getElementById("startupHelp");
    if (!window.NDAHI_READY && help) help.hidden = false;
  }, 12000);
}());
