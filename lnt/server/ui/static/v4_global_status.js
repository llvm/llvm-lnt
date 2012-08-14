// -*- mode: javascript; -*-

v4_global_status = {};
(function(_module) {
    // Assign our input module to a var so that a closure is created
    // in our local context.
    var m = _module;
    
    /* Globals */
    var g = {};
    
    /* Initialization */
    $(document).ready(function() {
        // Create a global variable for table.
        g.table = $('#data-table')[0];
        
        // Make left king control an accordion.
        $('#left-king-control').accordion({
            collapsible: true,
            autoHeight: false,
            active: 1
        });
        
        // Make our table headers fixed when we scroll.
        $('table#data-table th').each(function(i,v) {
            // Ensure that the headers of our table do not
            // change size when our table header switches to
            // fixed and back.
            var th = $(this);
            var width = th.outerWidth(true);
            th.css('width', width);
            th.css('min-width', width);
            th.css('max-width', width);
            th.css('margin', '0px');
            th.css('padding', '0px');
            
            var height = th.outerHeight(true);
            th.css('height', height);
            th.css('min-height', height);
            th.css('max-height', height);
        });        
        $('#data-table-header').scrollToFixed();
        
        // We serve up our results sorted correctly since sorttable.js does not
        // sort on page load (which is most likely done for performance reasons, I
        // guess?). The problem is that we do not have an initial arrow pointing up
        // or down. So we hack the arrow in.
        var initial_sort_header = document.getElementById('worst-time-header');
        sortrevind = document.createElement('span');
        sortrevind.id = "sorttable_sortrevind";
        sortrevind.innerHTML = '&nbsp;&#x25BE;';
        initial_sort_header.appendChild(sortrevind);

        $('.data-cell').contextMenu('contextmenu-datacell', {
           bindings: {
               'contextMenu-runpage' : function(elt) {
                   var new_base = elt.getAttribute('run_id') + '/graph?test.';
                   
                   field = getQueryParameterByName('field');
                   if (field == "")
                       field = 2; // compile time.
                   
                   new_base += elt.getAttribute('test_id') + '=' + field.toString();
                   window.location = url_replace_basename(window.location.toString(),
                                                          new_base);
               }
           }
       });
    });
    
    /* Helper Functions */
    
    function url_replace_basename(url, new_basename) {
        // Remove query string.
        var last_question_index = url.lastIndexOf('?');
        if (last_question_index != -1) 
            url = url.substring(0, last_question_index);
        if (url.charAt(url.length-1) == '/') {
            url = url.substring(0, url.length-1);
        }
        
        var without_base = url.substring(0, url.lastIndexOf('/') + 1);
        return without_base + new_basename;
    }
    
    function getQueryParameterByName(name) {
        name = name.replace(/[\[]/, "\\\[").replace(/[\]]/, "\\\]");
        var regexS = "[\\?&]" + name + "=([^&#]*)";
        var regex = new RegExp(regexS);
        var results = regex.exec(window.location.search);
        if(results == null)
            return "";
        else
            return decodeURIComponent(results[1].replace(/\+/g, " "));
    }    
    
    /* Exported Functions */
    
})(v4_global_status);
