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

    });
    
    /* Helper Functions */
    
    /* Exported Functions */
    
})(v4_global_status);
