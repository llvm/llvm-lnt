function RunTypeahead(element, options) {
    this.element = element;
    this.options = options;
    this.id = null;

    var this_ = this;
    element.typeahead({
        source: function(query, process) {
            $.ajax(options.searchURL, {
                dataType: "json",
                data: $.extend({}, this_.options.data, {'q': query}),
                success: function(data) {
                    process(data);
                },
                error: function(xhr, textStatus, errorThrown) {
                    pf_flash_error('accessing URL ' + options.searchURL +
                                   '; ' + errorThrown);
                }
            });
        },
        // These identity functions are required because the defaults
        // assume items are strings, whereas they're objects here.
        sorter: function(items) {
            // The results should be sorted on the server.
            return items;
        },
        matcher: function(item) {
            return item;
        },
        updater: function(item) {
            // FIXME: the item isn't passed in as json any more, it's
            // been rendered. Lame. To get around this, hack the
            // components of the 2-tuple back apart.
            name = item.split(',')[0];
            id = item.split(',')[1];
            this_.id = id;
            if (options.updated)
                options.updated(name, id);
            return name;
        },
        highlighter: function(item) {
            // item is a 2-tuple [name, obj].
            item = item[0];

            // This loop highlights each search term (split by space)
            // individually. The content of the for loop is lifted from
            // bootstrap.js (it's the original implementation of
            // highlighter()). In particular I have no clue what that regex
            // is doing, so don't bother asking.
            var arr = this.query.split(' ');
            for (i in arr) {
                query = arr[i];
                if (!query)
                    continue;
                var q = query.replace(/[\-\[\]{}()*+?.,\\\^$|#\s]/g,
                                          '\\$&')
                item = item.replace(new RegExp('(' + q + ')', 'ig'), function ($1, match) {
                    // We want to replace with <strong>match</strong here,
                    // but it's possible another search term will then
                    // match part of <strong>.
                    //
                    // Therefore, replace with two replaceable tokens that
                    // no search query is very likely to match...
                    return '%%%' + match + '£££'
                });
            }
            return item
                .replace(/%%%/g, '<strong>')
                .replace(/£££/g, '</strong>');
        }
    });
    // Bind an event disabling the function box and removing the profile
    // if the run box is emptied.
    element.change(function() {
        if (!element.val()) {
            this_.id = null;
            if (options.cleared)
                options.cleared();
        }
    });
}

RunTypeahead.prototype = {
    update: function (name, id) {
        this.element.val(name);
        this.id = id;
        if (this.options.updated)
            this.options.updated(name, id);
    },
    getSelectedRunId: function() {
        return this.id;
    }
};

function modifyURL(type, id) {
    var url = window.location.href;

    if (type == 'Current') {
        return url.replace(/\d+($|\?)/, id + '?');
    }
    if (type == 'Previous') {
        if (url.indexOf('compare_to=') != -1)
            return url.replace(/compare_to=\d+/, 'compare_to=' + id);
        else if (url.indexOf('?') != -1)
            return url + '&compare_to=' + id;
        else
            return url + '?compare_to=' + id;
    }
    if (type == 'Baseline') {
        if (url.indexOf('baseline=') != -1)
            return url.replace(/baseline=\d+/, 'baseline=' + id);
        else if (url.indexOf('?') != -1)
            return url + '&baseline=' + id;
        else
            return url + '?baseline=' + id;
    }
}

function makeEditable(type, td) {
    var exterior = $('<span></span>');

    var content = $('<input type="text">')
        .addClass("input-large");
    
    var title = $('<b></b>')
        .text('Choose run...')
        .append($('<span>&times;</span>')
                .addClass('close'));

    var enableTypeahead = function() {
        content.runTypeahead({
            searchURL: g_urls.search,
            data: {'m': g_machine},
            updated: function(name, id) {
                var url = modifyURL(type, id);
                document.location.href = url;
            },
            cleared: function()  {
            }
        });
        title.children('span').first().click(function() {
            exterior.popover('hide');
        });
    }

    var h = td.height() / 2;
    
    var interior = $('<span></span>')
        .css({marginTop: (h - 6) + 'px'})
        .addClass('icon-pencil icon-white');

    exterior.addClass('editable')
        .append(interior)
        .popover({
            title: title,
            content: content,
            html: true,
            trigger: 'click'
        }).on('shown.bs.popover', function(){
            enableTypeahead();
        });
    
    td.css({position: 'relative'})
        .append(exterior);
}

$(function() {

    jQuery.fn.extend({
        runTypeahead: function(options) {
            if (options)
                this.data('runTypeahead',
                          new RunTypeahead(this, options));
            return this.data('runTypeahead');
        }
    });
    
    makeEditable( 'Current', $('#run-table-Current')
                  .children('td')
                  .last());
    makeEditable( 'Previous', $('#run-table-Previous')
                  .children('td')
                  .last());
    makeEditable( 'Baseline', $('#run-table-Baseline')
                  .children('td')
                  .last());

});
