// -*- mode: javascript; -*-

String.prototype.pctToFloat = function() {
    return parseFloat(this.slice(0,-1));
};

v4_global_status = {};
(function(_module) {
    // Assign our input module to a var so that a closure is created
    // in our local context.
    var m = _module;
    
    /* Globals */
    var g = {};
    
    /* Initialization */
    m.init = function(field) {
        g.field = field;
        
        // Create a global variable for table.
        g.table = $('#data-table')[0];
        
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
        initial_sort_header.className += ' sorttable_sorted_reverse';
        sortrevind = document.createElement('span');
        sortrevind.id = "sorttable_sortrevind";
        sortrevind.innerHTML = '&nbsp;&#x25BE;';
        initial_sort_header.appendChild(sortrevind);

        $('.data-cell').contextMenu('contextmenu-datacell', {
           bindings: {
               'contextMenu-runpage' : function(elt) {
                   var new_base = elt.getAttribute('run_id') + '/graph?test.';
                   new_base += elt.getAttribute('test_id') + '=' + g.field.toString();
                   window.location = UrlReplaceBasename(window.location.toString(),
                                                          new_base);
               }
           }
       });
    };
    
    /* Helper Functions */
    
    function UrlReplaceBasename(url, new_basename) {
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
    
    function IsHidden(elem) {
        return elem.offsetWidth === 0 && elem.offsetHeight === 0;
    }
    
    /* Exported Functions */
    
    m.reset_table = function() {
        g.table.className = 'sortable_rev';
        
        // Sync checkboxes
        $('input:checkbox').each(function(i, val) {
            val.checked = true;
            val.disabled = false;
        });
        
        m.recompute_worst_times();
    };

    m.toggle_column_visibility = function(_col) {
        var col = _col;
        var classname = 'hide-' + col;
        $(g.table).toggleClass(classname);
        m.recompute_worst_times();
    };
    
    m.recompute_worst_times = function() {
        $('#data-table tr.data-row').each(function(index, value) {
            var cells = value.cells;
            var i = 2, length = cells.length;
            var max = -Infinity;
            var max_index = -1;
            for (; i < length; i++) {
                // We only consider visible cells.
                if (IsHidden(cells[i]))
                    continue;
                
                var flt = cells[i].innerHTML.pctToFloat();
                if (max < flt) {
                    max = flt;
                    max_index = i;
                }
            }
            
            cells[1].innerHTML = (max != -Infinity)? max.toString() + '%' : "";
            cells[1].setAttribute('bgcolor', (max_index != -1)? cells[max_index].getAttribute('bgcolor') : "#dbdbdb");            
        });
        
        // Resort.
        var initial_sort_header = document.getElementById('worst-time-header');
        initial_sort_header.className = initial_sort_header.className.replace('sorttable_sorted_reverse','').replace('sorttable_sorted','');
        $(initial_sort_header).trigger('click');
    };
    
})(v4_global_status);
